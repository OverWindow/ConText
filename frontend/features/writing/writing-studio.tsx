"use client";
import { useMemo, useState } from "react";
import type { Workspace } from "@/lib/api";
import { DraftStudio } from "../../shared/writing/draft-studio";
import { webDraftRepository } from "./web-draft-repository";
import { webAIRepository } from './web-ai-repository';
import { AISettings } from '../../shared/ui/ai-settings';

export function WritingStudio({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const repository = useMemo(() => webDraftRepository(workspace.id), [workspace.id]);
  const [settings, setSettings] = useState(false);
  return <><DraftStudio workspace={workspace} repository={repository} onClose={onClose} onAISettings={() => setSettings(true)} />{settings && <AISettings repository={webAIRepository} onClose={() => setSettings(false)} />}</>;
}
