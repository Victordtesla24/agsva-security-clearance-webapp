#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const envPath = process.env.LOCAL_APP_ENV_FILE || path.join(rootDir, '.env');
const outputPath = path.join(rootDir, 'firebase-config.js');

const supportedFields = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
  'measurementId'
];

const requiredFields = supportedFields.filter((field) => field !== 'measurementId');
const allowLegacySnippet = process.argv.includes('--allow-legacy-snippet');
const allowEmptyOutput = process.argv.includes('--allow-empty-output');

const envFieldMap = {
  apiKey: ['FIREBASE_API_KEY', 'FIREBASE_PUBLIC_API_KEY'],
  authDomain: ['FIREBASE_AUTH_DOMAIN', 'FIREBASE_PUBLIC_AUTH_DOMAIN'],
  projectId: ['FIREBASE_PROJECT_ID', 'FIREBASE_PUBLIC_PROJECT_ID'],
  storageBucket: ['FIREBASE_STORAGE_BUCKET', 'FIREBASE_PUBLIC_STORAGE_BUCKET'],
  messagingSenderId: ['FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_PUBLIC_MESSAGING_SENDER_ID'],
  appId: ['FIREBASE_APP_ID', 'FIREBASE_PUBLIC_APP_ID'],
  measurementId: ['FIREBASE_MEASUREMENT_ID', 'FIREBASE_PUBLIC_MEASUREMENT_ID']
};

function readDotEnvValues(filePath) {
  if (!fs.existsSync(filePath)) return { raw: '', values: {} };

  const raw = fs.readFileSync(filePath, 'utf8');
  const values = {};
  const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!envKeyPattern.test(key)) continue;

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return { raw, values };
}

function extractLegacyFirebaseConfig(raw) {
  const match = raw.match(/const\s+firebaseConfig\s*=\s*\{([\s\S]*?)\}\s*;?/u);
  if (!match) return {};

  const config = {};

  for (const line of match[1].split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fieldMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(['"])(.*?)\2\s*,?$/u);
    if (!fieldMatch) continue;

    const [, key, , value] = fieldMatch;
    if (!supportedFields.includes(key)) continue;
    config[key] = value;
  }

  return config;
}

function collectNormalizedFirebaseConfig(values) {
  const config = {};

  for (const [field, aliases] of Object.entries(envFieldMap)) {
    const alias = aliases.find((candidate) => values[candidate]);
    if (alias) config[field] = values[alias];
  }

  return config;
}

function validateFirebaseConfig(config) {
  const missing = requiredFields.filter((field) => !config[field]);
  return {
    valid: missing.length === 0,
    missing
  };
}

function renderFirebaseConfig(config) {
  const lines = ['window.__AGSVA_FIREBASE_CONFIG__ = Object.freeze({'];

  for (const field of supportedFields) {
    if (!config[field]) continue;
    lines.push(`  ${field}: ${JSON.stringify(String(config[field]))},`);
  }

  lines.push('});', '');
  return lines.join('\n');
}

function invalidConfigReason({ hasNormalizedConfig, hasLegacyConfig, validation }) {
  if (hasNormalizedConfig) {
    return `normalized FIREBASE_* values are incomplete. Missing: ${validation.missing.join(', ')}`;
  }

  if (hasLegacyConfig && !allowLegacySnippet) {
    return 'a legacy firebaseConfig block is present in .env. Promote those values to FIREBASE_* keys to enable Firebase persistence.';
  }

  return `Firebase config is incomplete. Missing: ${validation.missing.join(', ')}`;
}

function main() {
  const { raw, values } = readDotEnvValues(envPath);
  const legacyConfig = extractLegacyFirebaseConfig(raw);
  const normalizedConfig = collectNormalizedFirebaseConfig(values);
  const hasNormalizedConfig = Object.keys(normalizedConfig).length > 0;
  const hasLegacyConfig = Object.keys(legacyConfig).length > 0;
  const firebaseConfig = hasNormalizedConfig
    ? normalizedConfig
    : (allowLegacySnippet ? legacyConfig : {});
  const validation = validateFirebaseConfig(firebaseConfig);

  if (!validation.valid) {
    const reason = invalidConfigReason({ hasNormalizedConfig, hasLegacyConfig, validation });

    if (allowEmptyOutput) {
      if (fs.existsSync(outputPath)) {
        console.log(`firebase-config.js left unchanged because ${reason}`);
        return;
      }

      fs.writeFileSync(outputPath, renderFirebaseConfig({}), 'utf8');
      console.log(`firebase-config.js synchronized with an empty config because ${reason}`);
      return;
    }

    throw new Error(reason.charAt(0).toUpperCase() + reason.slice(1));
  }

  fs.writeFileSync(outputPath, renderFirebaseConfig(firebaseConfig), 'utf8');
  console.log(`firebase-config.js synchronized from ${path.relative(rootDir, envPath) || '.env'} for project ${firebaseConfig.projectId}.`);
}

main();
