import os
import sys
import time
import unittest
from local_process import captured


class LocalProcessTest(unittest.TestCase):
    def test_completed_command_retains_exit_status(self):
        r = captured([sys.executable, '-c', 'print("fixture");raise SystemExit(3)'],
                     cwd=os.getcwd(), env=os.environ.copy(), timeout=3)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(r.stdout.strip(), 'fixture')

    def test_timeout_closes_descendant_pipes_in_the_owned_process_group(self):
        code = 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"]);print("ready",flush=True);time.sleep(30)'
        start = time.monotonic()
        r = captured([sys.executable, '-c', code], cwd=os.getcwd(),
                     env=os.environ.copy(), timeout=.2)
        self.assertEqual(r.returncode, 124)
        self.assertIn('ready', r.stdout)
        self.assertLess(time.monotonic() - start, 6)


if __name__ == '__main__':
    unittest.main()
