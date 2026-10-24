"use client";
import { api } from "@/lib/api";

export type DocumentVersion = {
  id: string; document_id: string; version_number: number; original_filename: string;
  mime_type: string; size: number; sha256: string; uploaded_at?: string | null; created_at?: string; author_name?: string; source_version_id?: string | null; change_note?: string | null;
  status: "PENDING" | "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
};
export type WorkspaceDocument = {
  id: string; workspace_id: string; title: string; current_version_id: string | null;
  created_at: string; versions: DocumentVersion[];
};
export type UploadTicket = {
  document_id: string; version_id: string; upload_url: string;
  method: "PUT"; headers: Record<string, string>; expires_in: number;
};

export async function fileHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function completeUpload(versionId: string) {
  return api<WorkspaceDocument>("/documents/upload-complete", {
    method: "POST", body: JSON.stringify({ version_id: versionId }),
  });
}

export function sendFile(ticket: UploadTicket, file: File, onProgress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(ticket.method, ticket.upload_url);
    request.timeout = 10 * 60 * 1000;
    for (const [name, value] of Object.entries(ticket.headers)) request.setRequestHeader(name, value);
    // Only the signed S3 headers are sent. The application's Bearer token stays on API requests.
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      // An earlier request may have succeeded even if its response was lost.
      // 412 means the key exists; the backend must verify its checksum before accepting it.
      if ((request.status >= 200 && request.status < 300) || request.status === 412) resolve();
      else reject(new Error("업로드에 실패했습니다. 연결을 확인하고 같은 파일로 다시 시도해 주세요."));
    };
    request.onerror = () => reject(new Error("파일 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    request.ontimeout = () => reject(new Error("업로드 시간이 초과되었습니다. 업로드 완료 여부를 확인해 주세요."));
    request.send(file);
  });
}

export async function downloadVersion(versionId: string) {
  const { download_url } = await api<{ download_url: string }>(`/versions/${versionId}/download-url`, { method: "POST" });
  // S3 responds with Content-Disposition: attachment, including a UTF-8 filename.
  const link = document.createElement("a");
  link.href = download_url;
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
