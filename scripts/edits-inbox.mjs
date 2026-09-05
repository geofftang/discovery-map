#!/usr/bin/env node
// Laptop-side reader for the map-edit inbox in Vercel Blob (council step 7).
// The Python applier shells out to this so the Blob REST API is never hand-rolled.
//
//   node scripts/edits-inbox.mjs list           -> JSON array of {pathname, url, mutation}
//   node scripts/edits-inbox.mjs delete <pathname>...   -> deletes the given blobs (after the vault commit)
//
// Auth: BLOB_READ_WRITE_TOKEN from .env.vercel.local (pulled with `vercel env pull`), never printed.
import { list, get, del } from '@vercel/blob';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, '..', '.env.vercel.local');
if (!process.env.BLOB_READ_WRITE_TOKEN && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?$/);
    if (m) process.env.BLOB_READ_WRITE_TOKEN = m[1];
  }
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('BLOB_READ_WRITE_TOKEN missing: run `vercel env pull .env.vercel.local --environment=preview` in dist-private/');
  process.exit(2);
}

const [cmd, ...args] = process.argv.slice(2);

async function readBlob(pathname) {
  const result = await get(pathname, { access: 'private' });
  if (!result || result.statusCode !== 200) throw new Error(`get ${pathname}: ${result && result.statusCode}`);
  return await new Response(result.stream).text();
}

if (cmd === 'list') {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix: 'edits/inbox/', cursor, limit: 200 });
    for (const b of page.blobs) {
      let mutation = null;
      try { mutation = JSON.parse(await readBlob(b.pathname)); } catch (e) { mutation = { _unreadable: String(e) }; }
      out.push({ pathname: b.pathname, url: b.url, uploadedAt: b.uploadedAt, mutation });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => a.pathname.localeCompare(b.pathname));
  process.stdout.write(JSON.stringify(out) + '\n');
} else if (cmd === 'delete') {
  if (!args.length) { console.error('delete needs pathnames'); process.exit(1); }
  await del(args);
  process.stdout.write(JSON.stringify({ deleted: args.length }) + '\n');
} else {
  console.error('usage: edits-inbox.mjs list | delete <pathname>...');
  process.exit(1);
}
