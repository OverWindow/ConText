import { downloadSample, type SampleAIAdapter } from '@context/workspace-ui/sample-ai';
import { desktopAIRepository } from './draft-repository';

export const desktopSampleAI: SampleAIAdapter = {
  connection: desktopAIRepository,
  generate: request => window.contextDesktop.sampleGenerate(request),
  export: async (content, format) => {
    const output = await window.contextDesktop.sampleExport(content, format);
    const bytes = Uint8Array.from(atob(output.data), character => character.charCodeAt(0));
    downloadSample(new Blob([bytes]), content.title, format);
  },
};
