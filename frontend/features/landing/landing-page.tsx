import Link from "next/link";
import {
  LuArrowDownToLine, LuArrowRight, LuArrowUpRight,
  LuFilePenLine, LuGlobe, LuMessageCircle, LuMonitor, LuPlus, LuSparkles,
} from "react-icons/lu";
import { FaApple, FaWindows } from "react-icons/fa6";
import { BrandLogo } from "@/features/brand/brand-logo";
import { FileChatPreview } from "./file-chat-preview";
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
  { icon: LuMessageCircle, title: "내 자료를 찾고, AI에게 묻고", description: "평소 쓰던 폴더에서 필요한 자료를 찾으세요. 파일 내용을 바탕으로 질문하고, 답변의 출처까지 확인할 수 있어요." },
  { icon: LuFilePenLine, title: "자료를 바탕으로 문서 작성", description: "기존 자료로 초안을 만들고, AI 수정안을 비교하며 다듬으세요. TXT·Markdown은 원본을 편집하고, 다른 문서는 초안으로 가져와 작업해요." },
  { icon: LuMonitor, title: "내 PC에서 이어가는 작업", description: "파일 탐색·편집과 작업 기록을 내 기기에서 관리하세요. AI는 ChatKHU로 연결하고, 클라우드 동기화는 필요할 때 선택해요." },
];

const chatkhuSteps = [
  { title: "앱 설치하고 폴더 선택", description: "ConText를 설치하고 평소 쓰던 폴더를 선택하세요. 내 PC의 강의 자료·연구 노트·회의록으로 시작할 수 있어요." },
  { title: "내 ChatKHU를 연결하세요", description: "AI 연결 설정에서 ‘내 ChatKHU’를 선택하고, 개인 API 키를 등록한 뒤 사용할 모델을 선택하세요." },
  { title: "자료 탐색부터 문서 작성까지", description: "내 자료에 대해 질문하고 답변의 출처를 확인하세요. 자료를 바탕으로 초안을 만들고 문서를 다듬을 수 있어요." },
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
      <nav className={styles.navigation} aria-label="주 메뉴"><a href="#chatkhu">ChatKHU 활용</a><a href="#start">다운로드</a><Link href="/login" className={styles.loginLink}>로그인 <LuArrowUpRight aria-hidden="true" /></Link></nav>
    </div></header>
    <main id="main-content">
      <section className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.heroContent}>
          <p className={styles.eyebrow}><LuSparkles aria-hidden="true" /> 내 PC에서 시작하는 AI 문서 작업 공간</p>
          <h1 id="hero-title">내 문서와 AI가<br /><span>함께 일하는 공간.</span></h1>
          <p className={styles.heroDescription}>평소 쓰던 폴더에서 자료를 찾고, AI에게 묻고,<br />문서를 다듬으세요. 익숙한 내 파일로 작업을 이어갑니다.</p>
          <div className={styles.heroActions}><a href="#start" className={styles.primaryAction}><LuArrowDownToLine aria-hidden="true" /> 데스크톱 다운로드</a><Link href="/workspaces" className={styles.secondaryAction}>웹에서 시작하기 <LuArrowUpRight aria-hidden="true" /></Link></div>
          <p><Link href="/preview" className={styles.sampleLink}>로그인 없이 하루랩 샘플 둘러보기 <LuArrowRight aria-hidden="true" /></Link></p>
        </div>
        <FileChatPreview />
      </section>
      <section id="chatkhu" className={styles.chatkhu} aria-labelledby="chatkhu-title">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>경희대 ChatKHU 활용</p>
          <h2 id="chatkhu-title">내 폴더에 AI를 연결하는 간편한 시작.</h2>
          <p>ConText를 설치하고 경희대 ChatKHU를 연결하세요. 내 자료를 읽고, 묻고, 쓰는 작업을 시작할 수 있어요.</p>
        </div>
        <ol className={styles.chatkhuSteps}>{chatkhuSteps.map(({ title, description }, index) => <li key={title}>
          <span className={styles.stepNumber} aria-hidden="true">0{index + 1}</span><h3>{title}</h3><p>{description}</p>
        </li>)}</ol>
        <p className={styles.chatkhuNote}>AI 답변에는 인터넷 연결이 필요하며, 개인 키의 사용 크레딧은 해당 ChatKHU 계정에서 차감됩니다.</p>
      </section>
      <section id="features" className={styles.features} aria-labelledby="features-title">
        <div className={styles.sectionHeading}><h2 id="features-title">문서가 AI 작업의 바탕이 됩니다.</h2><p>자료 탐색과 AI 대화, 초안 작성과 편집을 내 문서 중심으로 이어가세요.</p></div>
        <div className={styles.featureGrid}>{features.map(({ icon: Icon, title, description }) => <article className={styles.feature} key={title}>
          <span className={styles.featureIcon}><Icon aria-hidden="true" /></span><h3>{title}</h3><p>{description}</p>
        </article>)}</div>
      </section>
      <section id="start" className={styles.start} aria-labelledby="start-title">
        <div className={styles.sectionHeading}><h2 id="start-title">내 컴퓨터에서 시작하세요.</h2><p>앱을 설치하고 작업할 폴더를 선택하세요. AI와 함께 쓰는 나만의 문서 환경이 시작됩니다.</p></div>
        <div className={styles.startGrid}>
          <article className={styles.desktopCard}>
            <span className={styles.platformIcon}><LuMonitor aria-hidden="true" /></span>
            <h3>나의 로컬 문서 작업 공간</h3><p className={styles.startDescription}>평소 쓰던 폴더에서 파일을 찾고 편집하세요. ChatKHU를 연결하면 자료를 바탕으로 질문하고 초안을 만들 수 있어요. 기본 파일 작업은 로그인 없이 시작할 수 있어요.</p>
            <div className={styles.downloads}>{platforms.map(({ name, detail, icon: Icon, url }) => <div className={styles.downloadOption} key={name}>
              <span><Icon aria-hidden="true" /><span><strong>{name}</strong>{detail && <small>{detail}</small>}</span></span>
              {url ? <a href={url} aria-label={name + " 다운로드"}><LuArrowDownToLine aria-hidden="true" /> 다운로드</a> : <button type="button" disabled aria-label={name + " 다운로드 배포 준비 중"}>배포 준비 중</button>}
            </div>)}</div>
          </article>
          <article className={styles.webCard}>
            <span className={styles.platformIcon}><LuGlobe aria-hidden="true" /></span>
            <h3>웹에서도 이어서</h3><p className={styles.startDescription}>동기화한 자료를 브라우저에서 열거나, 업로드한 자료로 AI와 대화하세요. 웹은 로그인 후 이용할 수 있어요.</p>
            <Link href="/workspaces" className={styles.secondaryAction}>웹에서 시작하기 <LuArrowRight aria-hidden="true" /></Link>
          </article>
        </div>
        <p className={styles.futureNote}>로컬 파일 작업은 내 기기에서. 클라우드 동기화는 필요할 때 선택하세요.</p>
      </section>
      <section className={styles.faq} aria-labelledby="faq-title">
        <div><h2 id="faq-title">시작하기 전에<br />궁금한 것들.</h2></div>
        <div className={styles.questions}>
          <details><summary>내 ChatKHU는 어떻게 연결하나요?<LuPlus aria-hidden="true" /></summary><p>ChatKHU에서 발급한 개인 API 키를 준비하세요. ConText의 AI 연결 설정에서 ‘내 ChatKHU’를 선택해 키를 등록하고, 연결을 확인한 뒤 모델을 선택·저장하면 됩니다. 개인 키의 사용 크레딧은 해당 ChatKHU 계정에서 차감돼요. 기본 ChatKHU 연결도 선택할 수 있어요.</p></details>
          <details><summary>샘플 자료가 내 워크스페이스에 저장되나요?<LuPlus aria-hidden="true" /></summary><p>하루랩 샘플은 로그인 없이 볼 수 있는 읽기 전용 프리뷰입니다. 개인 폴더나 클라우드에 샘플 파일을 생성하지 않아요. 내 자료로 작업하려면 나의 워크스페이스에서 시작하세요.</p></details>
          <details><summary>로컬 환경이면 AI도 오프라인으로 실행되나요?<LuPlus aria-hidden="true" /></summary><p>파일 탐색·검색·편집과 기록 보관은 내 기기에서 할 수 있어요. 현재 AI 답변은 인터넷과 별도 AI 연결이 필요하며, 질문에 필요한 자료의 발췌문을 연결한 AI 서비스로 전송합니다.</p></details>
          <details><summary>기존 파일에 바로 적용할 수 있나요?<LuPlus aria-hidden="true" /></summary><p>현재 TXT·Markdown은 텍스트 편집에서 원본에 저장할 수 있어요. DOCX·HWPX·PDF 등은 기존 내용을 새 초안으로 가져와 편집하고 별도 파일로 내보냅니다. AI 수정안은 초안에서 비교하고 적용할 수 있으며, 채팅에서 원본 파일에 바로 적용하는 흐름은 준비 중이에요.</p></details>
          <details><summary>내 파일이 자동으로 클라우드에 올라가나요?<LuPlus aria-hidden="true" /></summary><p>폴더를 선택하는 것만으로 파일 원본을 클라우드 저장소에 올리지 않아요. 같은 계정의 웹에서 자료를 보려면 데스크톱에서 클라우드 동기화를 직접 시작하세요. AI 질문에 필요한 발췌문 전송은 별도로 이루어집니다.</p></details>
        </div>
      </section>
    </main>
    <footer className={styles.footer}><Link href="/" className={styles.logo} aria-label="ConText 홈"><BrandLogo /></Link><span>© {new Date().getFullYear()} ConText</span></footer>
  </div>;
}
