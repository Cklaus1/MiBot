import os from 'os';
import path from 'path';
import fs from 'fs';

// Test isolation: give every test file its own on-disk SQLite DB under a temp dir, so
// suites that insert meetings/recordings no longer share ~/.config/mibot/mibot.db and
// race each other (the intermittent "1 failed" flake). Set before any src/db import runs.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-test-'));
process.env.MIBOT_DB_PATH = path.join(dir, 'test.db');
