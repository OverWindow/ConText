"use client";
import { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LuArrowUpRight } from 'react-icons/lu';
import '@xyflow/react/dist/style.css';
import { SampleWorkspace } from '@context/workspace-ui/sample-workspace';
import type { ApplicationNavigation } from '@context/workspace-ui/application';
import { webSampleAI } from './sample-ai';
export function SamplePreview() {
  const router = useRouter();
  const ai = useMemo(() => ({ ...webSampleAI, signIn: () => router.push('/login') }), [router]);
  const navigation = useMemo<ApplicationNavigation>(() => ({ logo: '/brand/context-logo.png', symbol: '/brand/context-symbol.png', spaces: [], onHome: () => router.push('/workspaces'), account: <Link className="secondary sample-start-account" href="/workspaces" aria-label="내 워크스페이스 시작하기"><LuArrowUpRight /><span>내 워크스페이스 시작하기</span></Link> }), [router]);
  return <SampleWorkspace navigation={navigation} ai={ai} />;
}
