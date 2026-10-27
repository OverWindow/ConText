import type { Metadata } from 'next';
import { SamplePreview } from '@/features/workspace/sample-preview';
export const metadata: Metadata = { title: '하루랩 샘플 둘러보기 · ConText', description: '로그인 없이 가상 스타트업의 문서·폴더·연결선을 살펴보세요.' };
export default function PreviewPage() { return <div className="app-shell"><SamplePreview /></div>; }
