import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CAPABILITY = "com.apple.runningboard.assertions.webkit"
COMMUNICATION = "com.apple.developer.usernotifications.communication"
REQUIRED = plistlib.loads((ROOT / "src-tauri/TrollStore.entitlements").read_bytes())


class SigningIdentityTests(unittest.TestCase):
    def merge(self, existing):
        with tempfile.TemporaryDirectory() as directory:
            folder = pathlib.Path(directory)
            (folder / "existing.plist").write_bytes(plistlib.dumps(existing) if existing is not None else b"")
            result = subprocess.run([
                sys.executable, str(ROOT / "scripts/ios-trollstore-entitlements.py"),
                str(folder / "existing.plist"), str(ROOT / "src-tauri/TrollStore.entitlements"),
                str(folder / "merged.plist"),
            ], capture_output=True, text=True)
            output = folder / "merged.plist"
            return result, plistlib.loads(output.read_bytes()) if output.exists() else None

    def test_unsigned_ipa_keeps_previous_trollstore_keychain_access(self):
        result, entitlements = self.merge(None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(entitlements["application-identifier"], "TROLLTROLL.*")
        self.assertEqual(entitlements["com.apple.developer.team-identifier"], "TROLLTROLL")
        self.assertEqual(entitlements["keychain-access-groups"], ["TROLLTROLL.*", "com.apple.token"])
        self.assertIs(entitlements[CAPABILITY], True)
        self.assertIs(entitlements[COMMUNICATION], True)
        self.assertNotIn("get-task-allow", entitlements)

    def test_repackaging_the_regressed_ipa_repairs_its_missing_identity(self):
        result, entitlements = self.merge({CAPABILITY: True})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(entitlements["keychain-access-groups"], ["TROLLTROLL.*", "com.apple.token"])

    def test_existing_signing_identity_and_groups_are_preserved(self):
        previous = {
            "application-identifier": "EXISTING.dev.estopia.free-grind",
            "com.apple.developer.team-identifier": "EXISTING",
            "keychain-access-groups": ["EXISTING.dev.estopia.free-grind"],
            "com.apple.security.application-groups": ["group.existing"],
        }
        result, entitlements = self.merge(previous)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(entitlements, {**previous, **REQUIRED})

    def test_partial_identity_is_rejected_instead_of_assigning_another_group(self):
        result, entitlements = self.merge({"application-identifier": "EXISTING.app"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(entitlements)
        self.assertIn("Incomplete existing keychain identity", result.stderr)


if __name__ == "__main__":
    unittest.main()
