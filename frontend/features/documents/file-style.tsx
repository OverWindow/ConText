import { LuFileText, LuFileType, LuFileCode2 } from "react-icons/lu";
import { PiFilePdfDuotone, PiFileDocDuotone } from "react-icons/pi";
const styles = {
  pdf: { name: "PDF", description: "PDF 문서", Icon: PiFilePdfDuotone },
  docx: { name: "DOCX", description: "워드 문서", Icon: PiFileDocDuotone },
  hwpx: { name: "HWPX", description: "한글 문서", Icon: LuFileType },
  txt: { name: "TXT", description: "텍스트 문서", Icon: LuFileText },
  md: { name: "MD", description: "마크다운 문서", Icon: LuFileCode2 },
};
export function fileStyle(filename?: string) {
  const extension = filename?.split(".").at(-1)?.toLowerCase() || "txt";
  const kind = extension in styles ? extension as keyof typeof styles : "txt";
  return { kind, ...styles[kind] };
}
