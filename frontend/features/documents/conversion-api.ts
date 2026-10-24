import { api } from "@/lib/api";

export type ConversionFormat = "pdf" | "docx" | "txt" | "md";
export type Conversion = {
  version_id: string; format: ConversionFormat;
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  attempts: number; error_message: string | null; size: number | null; warnings: string[] | null;
};

export async function downloadConversion(versionId: string, format: ConversionFormat) {
  const { download_url } = await api<{ download_url: string }>(`/versions/${versionId}/conversions/${format}/download-url`, { method: "POST" });
  const link = document.createElement("a");
  link.href = download_url;
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
