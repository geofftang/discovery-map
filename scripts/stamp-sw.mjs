#!/usr/bin/env node
// Post-build: give the copied service worker a per-build cache name so it reinstalls on deploy.
import { readFileSync, writeFileSync } from 'node:fs';
const file = `${process.argv[2]}/sw.js`;
writeFileSync(file, readFileSync(file, 'utf8').replace('__BUILD__', Date.now().toString(36)));
