"""
RunPod serverless handler for APoW Keccak-256 nonce grinding.

Wraps grinder-cuda in DAEMON mode — the CUDA binary stays alive across
handler invocations, eliminating ~500ms CUDA context init per grind.

Protocol (grinder-cuda --daemon):
  Startup:  prints "READY\n" after warmup kernel
  Stdin:    "<challenge> <target> <address>\n" to start grind
            "ABORT\n" to cancel current grind
  Stdout:   "F <idx> <nonce> <elapsed>" — found nonce
            "D <attempts> <elapsed>" — done (found or exhausted)
            "READY" — idle, ready for next challenge

Input:  { challenge: "0x...", target: "0x...", address: "0x..." }
Output: { nonce: "12345", elapsed: 1.234 }
"""

import subprocess
import threading
import time
import runpod


class CudaDaemon:
    """Persistent grinder-cuda --daemon subprocess wrapper."""

    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()
        self._start()

    def _start(self):
        """Launch daemon and wait for READY (CUDA context init + warmup kernel)."""
        self.proc = subprocess.Popen(
            ["./grinder-cuda", "--daemon"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # Line-buffered
        )
        # Wait for READY — daemon fires a warmup kernel at startup
        line = self.proc.stdout.readline().strip()
        if line != "READY":
            raise RuntimeError(f"Daemon failed to start: got '{line}'")

    def _is_alive(self):
        """Check if daemon process is still running."""
        return self.proc is not None and self.proc.poll() is None

    def _restart(self):
        """Kill dead daemon and start fresh."""
        if self.proc:
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
        self._start()

    def grind(self, challenge, target, address, timeout=90):
        """Send a grind challenge and wait for the result."""
        with self.lock:
            if not self._is_alive():
                self._restart()

            try:
                # Write challenge to daemon stdin
                self.proc.stdin.write(f"{challenge} {target} {address}\n")
                self.proc.stdin.flush()
            except BrokenPipeError:
                self._restart()
                self.proc.stdin.write(f"{challenge} {target} {address}\n")
                self.proc.stdin.flush()

            # Read output lines until we get a result
            deadline = time.monotonic() + timeout
            nonce = None
            elapsed = 0.0

            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # Timeout — send ABORT and wait for READY
                    try:
                        self.proc.stdin.write("ABORT\n")
                        self.proc.stdin.flush()
                        # Drain until READY
                        while True:
                            line = self.proc.stdout.readline().strip()
                            if line == "READY" or not line:
                                break
                    except Exception:
                        self._restart()
                    return {"error": f"Grind timed out after {timeout}s"}

                line = self.proc.stdout.readline().strip()

                if not line:
                    # EOF — daemon died
                    self._restart()
                    return {"error": "Daemon process died during grind"}

                parts = line.split()
                if not parts:
                    continue

                if parts[0] == "F" and len(parts) >= 4:
                    # Found: F <addr_index> <nonce> <elapsed>
                    nonce = parts[2]
                    elapsed = float(parts[3])

                elif parts[0] == "D":
                    # Done: D <attempts> <elapsed>
                    # Wait for READY
                    ready_line = self.proc.stdout.readline().strip()
                    if ready_line != "READY":
                        # Something went wrong, but we may still have a nonce
                        pass

                    if nonce is not None:
                        return {"nonce": nonce, "elapsed": elapsed}
                    else:
                        return {"error": "No nonce found (exhausted search space)"}

                elif parts[0] == "READY":
                    # Unexpected READY — grind completed without F line
                    if nonce is not None:
                        return {"nonce": nonce, "elapsed": elapsed}
                    return {"error": "Grind ended without finding nonce"}


# Module-level daemon — initialized ONCE at container boot.
# RunPod keeps Python globals alive between handler calls when
# refresh_worker is OFF.
daemon = CudaDaemon()


def handler(event):
    inp = event["input"]
    challenge = inp.get("challenge", "")
    target = inp.get("target", "")
    address = inp.get("address", "")

    if not challenge or not target or not address:
        return {"error": "Missing required fields: challenge, target, address"}

    return daemon.grind(challenge, target, address)


runpod.serverless.start({"handler": handler})
