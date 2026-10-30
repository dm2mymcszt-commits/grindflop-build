"""Merge our capability without losing the identity of earlier TrollStore installs."""

import pathlib
import plistlib
import sys


# TrollStore only supplies these defaults when a binary has NO entitlements.
# Our formerly unsigned IPAs used this identity. Embedding even one entitlement
# suppresses that fallback, so we must carry its keychain identity ourselves.
# https://github.com/opa334/TrollStore/blob/main/RootHelper/main.m#L582-L597
# get-task-allow is deliberately not added: debugging is unrelated to storage.
LEGACY_IDENTITY = {
    "application-identifier": "TROLLTROLL.*",
    "com.apple.developer.team-identifier": "TROLLTROLL",
    "keychain-access-groups": ["TROLLTROLL.*", "com.apple.token"],
}


def merge_entitlements(existing: dict, required: dict) -> dict:
    merged = dict(existing)
    identity_keys = LEGACY_IDENTITY.keys()
    if not any(key in merged for key in identity_keys):
        merged.update(LEGACY_IDENTITY)
    elif not all(merged.get(key) for key in identity_keys):
        # Never mix an existing signing identity with guessed fallback groups.
        raise ValueError("Incomplete existing keychain identity; refusing to change its access groups")
    if any(key in required for key in identity_keys):
        raise ValueError("Capability entitlements must not override the existing keychain identity")
    merged.update(required)
    return merged


if __name__ == "__main__":
    existing_path, required_path, output_path = map(pathlib.Path, sys.argv[1:])
    raw = existing_path.read_bytes()
    existing = plistlib.loads(raw) if raw else {}
    required = plistlib.loads(required_path.read_bytes())
    output_path.write_bytes(plistlib.dumps(merge_entitlements(existing, required)))
