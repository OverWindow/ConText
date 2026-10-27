export type ConversionFormat = 'pdf' | 'docx' | 'hwpx' | 'txt' | 'md';
export type ConversionJob = {
  version_id: string; format: ConversionFormat;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  attempts: number; error_message: string | null; size: number | null; warnings: string[] | null;
};
export type ConversionVersion = { id: string; version_number: number; original_filename: string; status: string };
export type ConversionDocument = { title: string; current_version_id: string | null; versions: ConversionVersion[] };
