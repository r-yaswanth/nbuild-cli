import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
const BUCKET = "nlearnv4.firebasestorage.app";
const BASE = "https://storage.googleapis.com";
export async function uploadToGcs(localPath, gcsPath, token, onProgress) {
    const totalBytes = fs.statSync(localPath).size;
    let uploadedBytes = 0;
    let lastReportedPercent = -1;
    const progressStream = new Transform({
        transform(chunk, _encoding, callback) {
            uploadedBytes += chunk.length;
            if (onProgress && totalBytes > 0) {
                const percent = Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100));
                if (percent !== lastReportedPercent) {
                    lastReportedPercent = percent;
                    onProgress(percent);
                }
            }
            callback(null, chunk);
        },
    });
    const data = fs.createReadStream(localPath).pipe(progressStream);
    const encodedName = encodeURIComponent(gcsPath);
    const url = `${BASE}/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o?uploadType=media&name=${encodedName}`;
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(totalBytes),
        },
        body: data,
        // Required for streaming request bodies in Node fetch.
        duplex: "half",
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GCS upload failed (${resp.status}): ${body}`);
    }
    if (onProgress && lastReportedPercent < 100) {
        onProgress(100);
    }
}
export async function downloadFromGcs(gcsPath, localPath, token, onProgress) {
    const encodedPath = encodeURIComponent(gcsPath);
    const url = `${BASE}/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodedPath}?alt=media`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GCS download failed (${resp.status}): ${body}`);
    }
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const body = resp.body;
    if (!body) {
        throw new Error("GCS download failed: empty response body");
    }
    const totalBytes = Number(resp.headers.get("content-length") ?? "0");
    let downloadedBytes = 0;
    let lastReportedPercent = -1;
    const reader = body.getReader();
    const chunks = [];
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        if (!value)
            continue;
        chunks.push(value);
        downloadedBytes += value.length;
        if (onProgress && totalBytes > 0) {
            const percent = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
            if (percent !== lastReportedPercent) {
                lastReportedPercent = percent;
                onProgress(percent);
            }
        }
    }
    fs.writeFileSync(localPath, Buffer.concat(chunks));
    if (onProgress && lastReportedPercent < 100) {
        onProgress(100);
    }
}
export async function gcsObjectExists(gcsPath, token) {
    const encodedPath = encodeURIComponent(gcsPath);
    const url = `${BASE}/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodedPath}`;
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 404)
        return false;
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GCS existence check failed (${resp.status}): ${body}`);
    }
    return true;
}
