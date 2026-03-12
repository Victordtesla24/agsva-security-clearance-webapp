import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const STATE_KEY = "primary";

function sanitizeFileName(name) {
    const normalized = String(name || "document")
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/gu, "-")
        .replace(/-+/gu, "-")
        .replace(/^-|-$/gu, "");

    return normalized || "document";
}

function toPlainJson(value) {
    return JSON.parse(JSON.stringify(value ?? {}));
}

function toDocumentPayload(row) {
    if (!row) return null;

    return {
        id: row.id,
        name: row.name,
        type: row.mime_type,
        size: row.size_bytes,
        category: row.category,
        uploaded: row.uploaded_at,
        status: row.status,
        validationState: row.validation_state
    };
}

export async function createPersistenceLayer(rootDir) {
    const configuredDataDir = process.env.LOCAL_APP_DATA_DIR
        ? (path.isAbsolute(process.env.LOCAL_APP_DATA_DIR)
            ? process.env.LOCAL_APP_DATA_DIR
            : path.resolve(rootDir, process.env.LOCAL_APP_DATA_DIR))
        : "";
    const dataDir = configuredDataDir || path.join(rootDir, "data");
    const uploadsDir = path.join(dataDir, "uploads");
    const databasePath = path.join(dataDir, "agsva-app.sqlite");

    await fsp.mkdir(uploadsDir, { recursive: true });

    const database = new DatabaseSync(databasePath);
    database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            category TEXT NOT NULL,
            uploaded_at TEXT NOT NULL,
            status TEXT NOT NULL,
            validation_state TEXT NOT NULL,
            storage_path TEXT NOT NULL
        );
    `);

    const statements = {
        getState: database.prepare(`
            SELECT value_json, updated_at
            FROM app_state
            WHERE key = ?
        `),
        saveState: database.prepare(`
            INSERT INTO app_state (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
        `),
        getDocument: database.prepare(`
            SELECT id, name, mime_type, size_bytes, category, uploaded_at, status, validation_state, storage_path
            FROM documents
            WHERE id = ?
        `),
        listDocuments: database.prepare(`
            SELECT id, name, mime_type, size_bytes, category, uploaded_at, status, validation_state, storage_path
            FROM documents
            ORDER BY uploaded_at DESC, id DESC
        `),
        upsertDocument: database.prepare(`
            INSERT INTO documents (
                id,
                name,
                mime_type,
                size_bytes,
                category,
                uploaded_at,
                status,
                validation_state,
                storage_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                mime_type = excluded.mime_type,
                size_bytes = excluded.size_bytes,
                category = excluded.category,
                uploaded_at = excluded.uploaded_at,
                status = excluded.status,
                validation_state = excluded.validation_state,
                storage_path = excluded.storage_path
        `),
        deleteDocument: database.prepare(`
            DELETE FROM documents
            WHERE id = ?
        `),
        countDocuments: database.prepare(`
            SELECT COUNT(*) AS count,
                   COALESCE(SUM(size_bytes), 0) AS total_bytes
            FROM documents
        `)
    };

    function getState() {
        const row = statements.getState.get(STATE_KEY);
        if (!row?.value_json) {
            return {
                state: {},
                updatedAt: ""
            };
        }

        try {
            return {
                state: JSON.parse(row.value_json),
                updatedAt: row.updated_at || ""
            };
        } catch {
            return {
                state: {},
                updatedAt: row.updated_at || ""
            };
        }
    }

    function saveState(state) {
        const normalizedState = toPlainJson(state);
        const updatedAt = new Date().toISOString();
        statements.saveState.run(STATE_KEY, JSON.stringify(normalizedState), updatedAt);

        return {
            state: normalizedState,
            updatedAt
        };
    }

    function listDocuments() {
        return statements.listDocuments.all().map((row) => toDocumentPayload(row));
    }

    function getDocumentRecord(id) {
        const row = statements.getDocument.get(id);
        if (!row) return null;

        return {
            ...toDocumentPayload(row),
            storagePath: row.storage_path
        };
    }

    async function saveDocument(document) {
        const id = document.id || crypto.randomUUID();
        const safeName = sanitizeFileName(document.name);
        const storagePath = path.join(uploadsDir, `${id}-${safeName}`);
        const contentBuffer = Buffer.from(document.contentBase64, "base64");
        const uploadedAt = document.uploaded || new Date().toISOString();

        await fsp.writeFile(storagePath, contentBuffer);

        statements.upsertDocument.run(
            id,
            document.name,
            document.type,
            document.size,
            document.category,
            uploadedAt,
            document.status || "uploaded",
            document.validationState || "pending",
            storagePath
        );

        return getDocumentRecord(id);
    }

    async function deleteDocument(id) {
        const existing = getDocumentRecord(id);
        if (!existing) return false;

        try {
            await fsp.rm(existing.storagePath, { force: true });
        } catch {
            // Best-effort cleanup; database delete still proceeds.
        }

        statements.deleteDocument.run(id);
        return true;
    }

    function health() {
        const state = getState();
        const counts = statements.countDocuments.get();
        const databaseBytes = fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0;

        return {
            dataDir,
            uploadsDir,
            databasePath,
            databaseBytes,
            documentsCount: Number(counts?.count || 0),
            documentBytes: Number(counts?.total_bytes || 0),
            stateUpdatedAt: state.updatedAt
        };
    }

    return {
        dataDir,
        uploadsDir,
        databasePath,
        getState,
        saveState,
        listDocuments,
        getDocumentRecord,
        saveDocument,
        deleteDocument,
        health
    };
}
