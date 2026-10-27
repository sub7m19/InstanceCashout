"""Zips the uploaded shipment photos into BACKUP_DIR (default: backups) and keeps the newest 14.

Run: python backup.py   (the server runs it nightly)
"""
import os
import shutil
import time
from pathlib import Path

from main import SITE_DIR, UPLOAD_DIR

KEEP = 14


def backup():
    folder = Path(os.environ.get("BACKUP_DIR") or SITE_DIR / "backups")
    folder.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    target = shutil.make_archive(str(folder / f"uploads-{time.strftime('%Y-%m-%d-%H%M%S')}"), "zip", UPLOAD_DIR)
    for old in sorted(folder.glob("uploads-*.zip"))[:-KEEP]:
        old.unlink()
    return target


if __name__ == "__main__":
    print(f"Backed up to {backup()}")
