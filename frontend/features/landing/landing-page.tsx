import Link from "next/link";
import {
  LuArrowDownToLine, LuArrowRight, LuArrowUpRight,
  LuGlobe, LuHistory, LuLink2, LuMonitor, LuPlus, LuSparkles,
} from "react-icons/lu";
import { FaApple, FaWindows } from "react-icons/fa6";
import { BrandLogo } from "@/features/brand/brand-logo";
import { WorkspacePreview } from "./workspace-preview";
import styles from "./landing.module.css";

function downloadUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const features = [
  { icon: LuLink2, title: "문서 캔버스", description: "자료를 캔버스에 펼치고 서로 연결하세요. 문서 사이의 흐름을 한눈에 볼 수 있어요." },
  { icon: LuHistory, title: "수정 이력", description: "바뀐 내용을 비교하고 이전 기록을 확인하세요. 최종본까지의 과정도 함께 남아요." },
  { icon: LuSparkles, title: "문서 기반 AI", description: "내 문서로 질문하고 초안을 작성하세요. 답변에 쓰인 자료의 출처도 확인할 수 있어요." },
];

export function LandingPage({ macDownloadUrl, windowsDownloadUrl }: { macDownloadUrl?: string; windowsDownloadUrl?: string }) {
  const platforms = [
    { name: "macOS", detail: "Apple Silicon", icon: FaApple, url: downloadUrl(macDownloadUrl) },
    { name: "Windows", detail: "", icon: FaWindows, url: downloadUrl(windowsDownloadUrl) },
  ];
  return <div className={styles.page}>
    <a className={styles.skipLink} href="#main-content">본문으로 건너뛰기</a>
    <header className={styles.header}><div className={styles.navInner}>
      <Link href="/" className={styles.logo} aria-label="ConText 홈"><BrandLogo /></Link>
      <nav className={styles.navigation} aria-label="주 메뉴"><a href="#features">ConText 소개</a><a href="#start">다운로드</a><Link href="/login" className={styles.loginLink}>로그인 <LuArrowUpRight aria-hidden="true" /></Link></nav>
    </div></header>
    <main id="main-content">
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroContent}>
          <h1 id="hero-title">흩어진 문서가,<br /><span>하나의 맥락으로.</span></h1>
          <p className={styles.heroDescription}>문서를 연결하고, AI와 생각을 정리하는 워크스페이스.<br />자료를 찾는 순간부터 새로운 글을 쓰는 순간까지 함께해요.</p>
          <div className={styles.heroActions}><Link href="/workspaces" className={styles.primaryAction}>웹에서 시작하기 <LuArrowUpRight aria-hidden="true" /></Link><a href="#start" className={styles.secondaryAction}><LuArrowDownToLine aria-hidden="true" /> 데스크톱 다운로드</a></div>
        </div>
        <WorkspacePreview />
      </section>
      <section id="features" className={styles.features} aria-labelledby="features-title">
        <div className={styles.sectionHeading}><h2 id="features-title">문서 사이의 생각을 발견하세요.</h2></div>
        <div className={styles.featureGrid}>{features.map(({ icon: Icon, title, description }) => <article className={styles.feature} key={title}>
          <span className={styles.featureIcon}><Icon aria-hidden="true" /></span><h3>{title}</h3><p>{description}</p>
        </article>)}</div>
      </section>
      <section id="start" className={styles.start} aria-labelledby="start-title">
        <div className={styles.sectionHeading}><h2 id="start-title">원하는 방식으로 시작하세요.</h2><p>브라우저에서 함께 작업하거나, 내 컴퓨터의 파일을 편하게 살펴보세요.</p></div>
        <div className={styles.startGrid}>
          <article className={styles.webCard}>
            <span className={styles.platformIcon}><LuGlobe aria-hidden="true" /></span>
            <h3>웹</h3><p className={styles.startDescription}>설치 없이 로그인하고 팀 문서를 관리하세요. 문서 기반 AI 채팅과 글쓰기를 바로 이용할 수 있어요.</p>
            <Link href="/workspaces" className={styles.primaryAction}>웹에서 시작하기 <LuArrowRight aria-hidden="true" /></Link>
          </article>
          <article className={styles.desktopCard}>
            <span className={styles.platformIcon}><LuMonitor aria-hidden="true" /></span>
            <h3>데스크톱</h3><p className={styles.startDescription}>내 컴퓨터의 폴더를 연결해 파일을 탐색하고 배치하세요. 원본 파일의 위치와 내용은 그대로 유지돼요.</p>
            <div className={styles.downloads}>{platforms.map(({ name, detail, icon: Icon, url }) => <div className={styles.downloadOption} key={name}>
              <span><Icon aria-hidden="true" /><span><strong>{name}</strong>{detail && <small>{detail}</small>}</span></span>
              {url ? <a href={url} aria-label={name + " 다운로드"}><LuArrowDownToLine aria-hidden="true" /> 다운로드</a> : <button type="button" disabled aria-label={name + " 다운로드 배포 준비 중"}>배포 준비 중</button>}
            </div>)}</div>
          </article>
        </div>
        <p className={styles.futureNote}>계정 연동 · 기기 간 동기화 준비 중</p>
      </section>
      <section className={styles.faq} aria-labelledby="faq-title">
        <div><h2 id="faq-title">시작하기 전에<br />궁금한 것들.</h2></div>
        <div className={styles.questions}>
          <details><summary>웹을 쓰려면 앱을 설치해야 하나요?<LuPlus aria-hidden="true" /></summary><p>설치하지 않아도 됩니다. ‘웹에서 시작하기’를 누르고 로그인하면 브라우저에서 ConText를 이용할 수 있어요.</p></details>
          <details><summary>웹과 데스크톱의 문서는 자동으로 연결되나요?<LuPlus aria-hidden="true" /></summary><p>아직 자동으로 연결되지 않습니다. 현재 웹 워크스페이스와 데스크톱의 로컬 폴더는 각각 독립적으로 동작해요. 같은 계정으로 연결하고 기기 사이에서 동기화하는 기능은 추후 제공할 예정입니다.</p></details>
          <details><summary>데스크톱에서 원본 파일이 바뀌나요?<LuPlus aria-hidden="true" /></summary><p>캔버스에서 파일을 배치해도 원본 파일의 위치나 내용은 바뀌지 않아요. 현재 데스크톱은 폴더 탐색, 파일 배치, 미리보기와 원본 열기를 지원합니다.</p></details>
        </div>
      </section>
    </main>
    <footer className={styles.footer}><Link href="/" className={styles.logo} aria-label="ConText 홈"><BrandLogo /></Link><span>© {new Date().getFullYear()} ConText</span></footer>
  </div>;
}
