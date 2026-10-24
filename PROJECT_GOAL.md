# Project Goal
## AI-Native Team Document Management System

---

# 1. 프로젝트 목표

AI를 활용해 팀 문서를 생성하고 관리하는 환경이 늘어나면서 다음 문제가 커지고 있다.

- 어떤 문서가 최신 버전인지 알기 어렵다.
- 비슷한 문서가 계속 복제된다.
- 문서가 왜 변경되었는지 맥락이 사라진다.
- 과거 문서를 찾고 내용을 비교하는 비용이 크다.
- PDF, DOCX, HWPX, Markdown 등 형식이 제각각이다.
- AI가 생성한 문서까지 늘어나면서 사람이 직접 문서 관계를 관리하기 어려워진다.

이 프로젝트의 목표는 다음과 같다.

> **팀 문서의 현재 상태와 변화의 맥락을 한눈에 이해하게 해주는 AI-Native 문서 관리 시스템을 구축한다.**

단순 파일 저장소가 아니라,

```text
Document
+
Version History
+
Change Context
+
Team Knowledge
+
AI
```

를 하나의 Workspace에서 관리하는 것을 목표로 한다.

최종적으로는 사람이 만든 문서뿐 아니라 GPT, Gemini 등의 AI Agent가 만든 문서까지 동일한 Version / Provenance 체계로 관리하는 시스템을 만든다.

---

# 2. 핵심 제품 컨셉

기존 파일 관리:

```text
proposal.pdf
proposal_v2.pdf
proposal_final.pdf
proposal_final_real.pdf
```

이 시스템에서는:

```text
Proposal

V1
 ↓
V2
 ↓
V3
 ↓
V4 ← Current
```

와 같이 하나의 논리적인 Document와 여러 DocumentVersion으로 관리한다.

각 Version 사이에는 다음 정보가 존재한다.

```text
V2 → V3

변경 요약:
- 가격 정책 수정
- 일본 시장 분석 추가
- 경쟁사 2개 추가

변경 작업자:
Kim

변경 시간:
2026-10-07
```

AI는 각 버전 사이의 실제 변경 내용을 분석해 자연어로 요약한다.

---

# 3. 제품의 핵심 원칙

## 3.1 File과 Document를 분리한다

Document는 논리적 문서이다.

```text
사업계획서
```

DocumentVersion은 실제 파일 또는 특정 시점의 문서 상태이다.

```text
사업계획서

├ V1 → proposal.pdf
├ V2 → proposal.docx
└ V3 → proposal.pdf
```

파일 형식이 바뀌어도 같은 Document의 Version이 될 수 있다.

---

## 3.2 Version First

문서를 단순 파일 목록으로 관리하지 않는다.

기본 구조:

```text
Document
   ↓
DocumentVersion
```

---

## 3.3 Everything Has Provenance

가능한 모든 변경은 추적할 수 있어야 한다.

```text
누가
언제
무엇을
왜
어떻게
변경했는가
```

AI 결과도 근거를 추적할 수 있어야 한다.

---

## 3.4 AI는 부가기능이 아니다

다음 기능 모두에서 AI를 사용한다.

```text
Version Detection
Change Summary
Document Search
RAG Chat
Relationship Analysis
Workspace Summary
```

---

# 4. 주요 기술 스택

Frontend:

```text
Next.js
TypeScript
React
React Flow
```

Backend:

```text
Python
FastAPI
```

Database:

```text
PostgreSQL
pgvector
```

Object Storage:

```text
Amazon S3
```

Authentication:

```text
Supabase Auth
Google OAuth
```

AI API:

```text
Mindlogic API Gateway
```

LLM:

```text
gpt-5.6-luna
```

Background Processing:

```text
Redis
+
Celery / Dramatiq / RQ
```

중 하나.

프로젝트는 Docker 환경에서 실행 가능하도록 만든다.

---

# 5. AI API

OpenAI API를 직접 사용하지 않는다.

Mindlogic API Gateway를 사용한다.

Base URL:

```text
https://factchat-cloud.mindlogic.ai/v1/gateway
```

기본 모델:

```text
gpt-5.6-luna
```

환경 변수:

```env
MINDLOGIC_API_KEY=...
MINDLOGIC_BASE_URL=https://factchat-cloud.mindlogic.ai/v1/gateway
AI_MODEL=gpt-5.6-luna
```

Business Logic에서 API Client를 직접 호출하지 않는다.

구조:

```text
DocumentService
      ↓
AIService
      ↓
AIProvider
      ↓
MindlogicProvider
```

Provider abstraction을 둔다.

예:

```python
class AIProvider:
    async def generate(self, messages, model=None):
        ...

    async def embed(self, texts):
        ...
```

초기 구현체:

```text
MindlogicProvider
```

향후:

```text
OpenAIProvider
GeminiProvider
ClaudeProvider
```

등으로 확장 가능하게 한다.

---

# 6. Authentication

MVP부터 로그인 기능을 포함한다.

Authentication Provider:

```text
Supabase Auth
```

초기 로그인 방식:

```text
Google OAuth
```

MVP에서는 이메일/비밀번호 회원가입, 비밀번호 찾기, 복잡한 프로필 관리 등은 제외한다.

인증 흐름:

```text
User
 ↓
Google OAuth
 ↓
Supabase Auth
 ↓
JWT
 ↓
FastAPI
 ↓
JWT Validation
 ↓
Application User
```

Supabase는 다음만 담당한다.

```text
이 사용자가 누구인가?
```

Application Database는 다음을 담당한다.

```text
이 사용자가 어떤 Workspace에 접근 가능한가?
```

---

# 7. User / Team / Workspace

핵심 Entity:

```text
User

Team

TeamMember

Workspace

WorkspaceMember

Document

DocumentVersion
```

User 예:

```text
id
auth_user_id
email
display_name
created_at
```

WorkspaceMember:

```text
id
workspace_id
user_id
role
created_at
```

Role:

```text
OWNER
EDITOR
VIEWER
```

---

# 8. 권한

OWNER:

```text
Workspace 관리
Member 관리
문서 생성
문서 수정
문서 삭제
Version 생성
AI 기능 사용
```

EDITOR:

```text
문서 생성
문서 수정
Version 생성
AI 기능 사용
```

VIEWER:

```text
문서 조회
Version History 조회
AI Chat 사용
```

모든 문서 API에서 권한을 검사한다.

예:

```text
Request

↓

JWT Validation

↓

User

↓

WorkspaceMember 확인

↓

Role 확인

↓

Action 실행
```

---

# 9. Main Workspace UI

일반적인 Google Drive 형태의 파일 리스트를 중심으로 설계하지 않는다.

메인 화면은 자유로운 Canvas / Desktop 형태이다.

배경:

```text
Mesh Grid
```

예:

```text
┌──────────────────────────────────────┐
│                                      │
│      📄 사업계획서                   │
│          │                           │
│          ▼                           │
│      📄 V2                           │
│          │                           │
│          ▼                           │
│      📄 V3                           │
│                                      │
│                      📊 시장조사     │
│                           │          │
│                           ▼          │
│                      📄 경쟁사 분석  │
│                                      │
└──────────────────────────────────────┘
```

기능:

```text
Zoom
Pan
Drag
Drop
Node Selection
Position Persistence
Document Preview
```

React Flow 또는 적절한 Node/Edge 기반 라이브러리를 사용한다.

---

# 10. Document Relation

Document 또는 Version 사이의 관계를 Edge로 표현할 수 있도록 설계한다.

relation_type 예:

```text
VERSION
REFERENCE
DERIVED_FROM
GENERATED_FROM
RELATED_TO
```

예:

```text
시장조사
   │
   └── REFERENCE ──→ 사업계획서
```

---

# 11. Document Upload

지원 대상:

```text
PDF
DOCX
HWPX
TXT
Markdown
```

추후:

```text
PPTX
XLSX
Google Docs
Notion
```

업로드 시 FastAPI를 통해 파일 전체를 중계하지 않는다.

Presigned URL을 사용한다.

```text
Browser
 ↓
FastAPI
 ↓
Presigned URL 발급
 ↓
Browser
 ↓
S3 Direct Upload
```

---

# 12. Amazon S3

Region:

```text
ap-northeast-2
```

서울 리전을 기본값으로 한다.

개발:

```text
ai-doc-workspace-dev
```

운영:

```text
ai-doc-workspace-prod
```

환경별 Bucket을 분리한다.

Bucket은 Private으로 유지한다.

설정:

```text
Block Public Access = ON
Object Ownership = Bucket owner enforced
Encryption = SSE-S3
```

ACL 사용을 피한다.

---

# 13. S3 역할

S3에는 실제 Binary 파일을 저장한다.

예:

```text
PDF
DOCX
HWPX
Converted PDF
Normalized JSON
Extracted Text
Preview Files
```

PostgreSQL은 메타데이터와 시스템 상태를 저장한다.

```text
PostgreSQL = Source of Truth

S3 = Binary Storage
```

S3 객체 목록을 읽어 시스템 상태를 결정하지 않는다.

---

# 14. S3 Path

원래 파일명을 Object Key의 핵심 식별자로 사용하지 않는다.

기본 Path:

```text
teams/{team_id}/
workspaces/{workspace_id}/
documents/{document_id}/
versions/{version_id}/
```

예:

```text
teams/team_123/
workspaces/workspace_456/
documents/doc_789/
versions/ver_101/
original.pdf
```

변환 파일:

```text
versions/ver_101/

├ original.hwpx
├ extracted.txt
├ normalized.json
└ converted/
   ├ document.pdf
   └ document.docx
```

원래 사용자가 올린 파일명은 DB에 저장한다.

---

# 15. Presigned URL

Upload:

```text
POST /api/documents/upload-url
```

Backend:

```text
1. JWT 검증
2. Workspace 권한 검사
3. DocumentVersion 생성
4. Storage Key 생성
5. Presigned PUT URL 생성
```

Browser가 S3에 직접 업로드한다.

업로드 후:

```text
POST /api/documents/upload-complete
```

Backend는 S3 Object 존재를 확인하고 Processing을 시작한다.

---

# 16. S3 Download

다운로드 및 Preview에서도 Presigned URL을 사용한다.

```text
Browser

↓

Backend

↓

JWT Validation

↓

Workspace Permission

↓

Presigned GET URL

↓

S3
```

URL은 짧은 시간만 유효하도록 한다.

MVP 기본값:

```text
5~15 minutes
```

---

# 17. DocumentVersion 상태

DocumentVersion은 상태를 가진다.

```text
PENDING
UPLOADING
UPLOADED
PROCESSING
READY
FAILED
```

---

# 18. Background Processing

업로드 후 다음 작업은 Background Worker에서 실행한다.

```text
Validate File
Parse
Normalize
Extract Text
Hash
Chunk
Embed
Version Detection
Diff
AI Summary
Preview Generation
```

흐름:

```text
Upload Complete

↓

Job Queue

↓

Worker

├ Parse
├ Normalize
├ Embed
├ Version Analyze
└ AI Summary
```

---

# 19. NormalizedDocument

문서 포맷마다 Business Logic을 별도로 만들지 않는다.

공통 문서 구조:

```json
{
  "title": "Document",
  "blocks": [
    {
      "type": "heading",
      "level": 1,
      "text": "Market Analysis"
    },
    {
      "type": "paragraph",
      "text": "..."
    }
  ]
}
```

흐름:

```text
PDF
DOCX
HWPX
TXT
MD

  ↓

NormalizedDocument

  ↓

Parser / Diff / AI / Converter
```

---

# 20. Format Conversion

잘못된 구조:

```text
PDF → DOCX
PDF → MD
PDF → TXT
DOCX → PDF
DOCX → MD
...
```

사용하지 않는다.

대신:

```text
PDF
DOCX
HWPX
TXT
MD

↓

NormalizedDocument

↓

PDF
DOCX
MD
TXT
```

구조로 구현한다.

---

# 21. Version Management

Document:

```text
id
workspace_id
title
current_version_id
created_by
created_at
```

DocumentVersion:

```text
id
document_id
version_number
storage_key
original_filename
mime_type
size
sha256
created_by
created_at
status
```

Version Number는 Application Database에서 관리한다.

S3 Versioning을 Document Version 시스템으로 사용하지 않는다.

---

# 22. Automatic Version Detection

새 문서가 업로드되면 기존 Document의 새 Version인지 판단한다.

Pipeline:

```text
New Upload

↓

SHA-256

↓

Filename Similarity

↓

Text Similarity

↓

Embedding Similarity

↓

필요한 경우 GPT-5.6 Luna

↓

Version Candidate
```

결과 예:

```json
{
  "document_id": "doc_123",
  "confidence": 0.94
}
```

초기에는 자동 확정 대신 사용자에게 제안하는 방식이 좋다.

```text
이 파일은 '사업계획서'의 새 버전으로 보입니다.

Similarity: 94%

[새 버전으로 등록]
[새 문서로 등록]
```

---

# 23. Duplicate Detection

SHA-256 Hash를 저장한다.

동일한 Hash라면:

```text
Exact Duplicate
```

로 판단할 수 있다.

---

# 24. AI Change Detection

새 Version이 기존 Version과 연결되면 변경사항을 계산한다.

흐름:

```text
Old Version
+
New Version

↓

NormalizedDocument

↓

Text / Block Diff

↓

Changed Sections

↓

GPT-5.6 Luna

↓

Structured Change Summary
```

LLM에 두 문서 전체를 무조건 보내지 않는다.

먼저 Diff를 계산하고 변경된 부분 중심으로 AI에 전달한다.

---

# 25. AI Change Summary

예:

```json
{
  "summary": "시장 규모와 가격 정책이 변경되었습니다.",
  "added": [
    "일본 시장 분석"
  ],
  "removed": [
    "기존 무료 플랜"
  ],
  "modified": [
    {
      "field": "Pro 가격",
      "before": "9,900원",
      "after": "12,900원"
    }
  ]
}
```

가능하면 Structured Output으로 저장한다.

---

# 26. Version Timeline

Document 상세 화면:

```text
사업계획서

V1
 │
 ▼
V2
 │
 │ 가격 정책 수정
 │ 시장 데이터 추가
 ▼
V3
 │
 ▼
Current
```

각 Version 클릭 시:

```text
파일 Preview
AI Change Summary
작성자
작성 시간
```

을 표시한다.

---

# 27. RAG

Workspace 내 모든 문서를 대상으로 Chat을 제공한다.

Pipeline:

```text
DocumentVersion

↓

NormalizedDocument

↓

Chunk

↓

Embedding

↓

PostgreSQL + pgvector

↓

Semantic Search

↓

Relevant Chunks

↓

GPT-5.6 Luna

↓

Answer + Sources
```

---

# 28. AI Chat

예:

```text
User:

현재 우리 팀의 가격 정책을 정리해줘.
```

답변:

```text
현재 최신 사업계획서 기준:

Basic
9,900원

Pro
19,900원

Enterprise
별도 문의
```

그리고 반드시 Source를 제공한다.

```text
Sources

사업계획서 V4
Page 5

가격정책 회의록 V2
Page 2
```

---

# 29. Version-Aware Retrieval

RAG에서 오래된 버전이 최신 버전과 동일한 중요도로 검색되는 문제를 고려한다.

기본적으로:

```text
Current Version
```

을 우선 검색한다.

사용자가 과거를 명시하면:

```text
"지난 3월 당시 가격 정책 알려줘"
```

과거 Version까지 검색한다.

---

# 30. Embedding

Mindlogic Gateway의 Embedding 기능 사용을 우선 고려한다.

Vector Storage:

```text
PostgreSQL
+
pgvector
```

Pinecone 등 별도 Vector SaaS는 MVP에서 사용하지 않는다.

---

# 31. Team AI Chat

Workspace 단위로 Chat Session을 관리한다.

Entity:

```text
ChatSession

ChatMessage
```

Chat은 해당 Workspace의 문서만 검색해야 한다.

다른 Workspace 데이터가 Retrieval되는 일이 절대 없어야 한다.

---

# 32. Activity

문서 작업 기록을 남긴다.

예:

```text
Today

사업계획서
V3 → V4

Updated by Kim

AI Summary:
- 일본 시장 분석 추가
- 가격 정책 변경
```

향후 AI에:

```text
이번 주에 팀 문서에서 뭐가 바뀌었어?
```

라고 질문할 수 있어야 한다.

---

# 33. Login UI

로그인 화면은 최소화한다.

```text
AI Document Workspace

[ Continue with Google ]
```

첫 로그인 후 Workspace가 없다면:

```text
Create Workspace
```

화면으로 이동한다.

Workspace 생성자는 자동으로:

```text
OWNER
```

가 된다.

---

# 34. 팀 초대

초기에는 단순하게 구현한다.

가능하면:

```text
Email
+
Role
```

기반 초대를 지원한다.

Role:

```text
EDITOR
VIEWER
```

초대 기능 구현 비용이 크다면 MVP 1차에서는 제외 가능하다.

그러나 DB Model은 Team / Workspace Member 기반으로 미리 설계한다.

---

# 35. Repository Structure

권장:

```text
project/

├ frontend/
│
│ ├ app/
│ ├ components/
│ ├ features/
│ │ ├ auth/
│ │ ├ workspace/
│ │ ├ documents/
│ │ ├ versions/
│ │ └ chat/
│ └ lib/
│
├ backend/
│
│ ├ app/
│ ├ api/
│ ├ models/
│ ├ services/
│ │
│ ├ auth/
│ │ └ supabase.py
│ │
│ ├ ai/
│ │ ├ provider.py
│ │ ├ mindlogic.py
│ │ └ prompts/
│ │
│ ├ storage/
│ │ └ s3.py
│ │
│ ├ documents/
│ │ ├ parser/
│ │ ├ normalize/
│ │ ├ diff/
│ │ └ converter/
│ │
│ ├ rag/
│ │
│ └ workers/
│
├ docker-compose.yml
│
└ README.md
```

---

# 36. Environment Variables

예:

```env
# Database

DATABASE_URL=postgresql://...


# Authentication

SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_JWT_SECRET=...


# AI

MINDLOGIC_API_KEY=...
MINDLOGIC_BASE_URL=https://factchat-cloud.mindlogic.ai/v1/gateway
AI_MODEL=gpt-5.6-luna


# AWS

AWS_REGION=ap-northeast-2
AWS_S3_BUCKET=ai-doc-workspace-dev

AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...


# Redis

REDIS_URL=redis://redis:6379
```

Production이 AWS 환경이라면 가능하면 AWS Access Key 대신 IAM Role을 사용한다.

---

# 37. 핵심 Database Model

필수 Entity:

```text
User
Team
TeamMember

Workspace
WorkspaceMember

Document
DocumentVersion

DocumentRelation
DocumentChange

DocumentChunk

ChatSession
ChatMessage
```

대략적인 관계:

```text
User
 │
 └─ TeamMember
       │
       ▼
      Team
       │
       └─ Workspace
            │
            ├─ WorkspaceMember
            │
            ├─ Document
            │    │
            │    └─ DocumentVersion
            │
            └─ ChatSession
```

---

# 38. 초기 API 설계 예

Auth:

```text
GET /me
```

Workspace:

```text
POST /workspaces

GET /workspaces

GET /workspaces/{id}
```

Documents:

```text
POST /workspaces/{id}/documents/upload-url

POST /documents/{id}/upload-complete

GET /documents/{id}

DELETE /documents/{id}
```

Versions:

```text
GET /documents/{id}/versions

GET /versions/{id}

POST /documents/{id}/versions

POST /versions/{id}/download-url
```

AI:

```text
POST /versions/{id}/summarize

POST /documents/version-detect

POST /workspaces/{id}/chat
```

---

# 39. 보안 원칙

반드시 지킨다.

```text
AI API Key를 Browser에 노출하지 않는다.

AWS Secret Key를 Browser에 노출하지 않는다.

Private S3 Bucket을 사용한다.

모든 Document API에서 Workspace 권한을 검사한다.

Presigned URL을 발급하기 전에 권한을 검사한다.

RAG Query에는 반드시 Workspace Scope를 적용한다.
```

---

# 40. Phase 1 — Foundation

목표:

```text
서비스의 기본 뼈대를 만든다.
```

구현:

```text
Docker
Next.js
FastAPI
PostgreSQL
Redis

Supabase Auth
Google OAuth

User
Team
Workspace
WorkspaceMember

OWNER / EDITOR / VIEWER
```

성공 조건:

```text
Google 로그인 가능

Workspace 생성 가능

로그인 사용자만 Workspace 접근 가능
```

---

# 41. Phase 2 — Document Storage

구현:

```text
Document
DocumentVersion

S3

Presigned Upload

Presigned Download

Document Metadata
```

성공 조건:

```text
사용자가 문서를 업로드할 수 있다.

문서가 S3 Private Bucket에 저장된다.

DocumentVersion이 DB에 생성된다.

권한 없는 사용자는 다운로드할 수 없다.
```

---

# 42. Phase 3 — Canvas Workspace

구현:

```text
Mesh Grid

Document Node

Drag & Drop

Zoom / Pan

Node Position Persistence

Document Relation Edge
```

목표:

```text
Google Drive 같은 파일 리스트가 아니라
프로젝트 지식 공간처럼 느껴지는 UI
```

---

# 43. Phase 4 — Document Processing

구현:

```text
PDF Parser

DOCX Parser

HWPX Parser

TXT Parser

Markdown Parser

NormalizedDocument

Text Extraction

SHA-256
```

Background Worker에서 처리한다.

---

# 44. Phase 5 — Version Management

구현:

```text
Manual Version Linking

Version Timeline

Current Version

Duplicate Detection

Version Compare
```

성공 조건:

```text
한 Document에 여러 Version을 관리할 수 있다.
```

---

# 45. Phase 6 — AI Version Intelligence

구현:

```text
Text Diff

Block Diff

Semantic Similarity

Embedding Similarity

Version Candidate Detection

GPT-5.6 Luna Change Summary
```

---

# 46. Phase 7 — RAG

구현:

```text
Chunk

Embedding

pgvector

Semantic Search

GPT-5.6 Luna

Citation
```

성공 조건:

```text
Workspace 전체 문서를 대상으로 질문할 수 있다.

답변에 Document / Version 근거가 표시된다.
```

---

# 47. Phase 8 — Format Conversion

구현:

```text
NormalizedDocument

↓

PDF
TXT
Markdown
DOCX
```

HWPX → PDF 등 주요 변환을 지원한다.

---

# 48. Phase 9 — AI-Native Workspace

추가 기능:

```text
Weekly Workspace Summary

Document Relationship Suggestion

Automatic Organization

AI Document Generation

AI Document Editing

Knowledge Graph
```

---

# 49. Phase 10 — AI Agent Integration

향후 GPT / Gemini / Claude Agent가 Workspace를 직접 다룰 수 있도록 한다.

인터페이스:

```text
REST API

MCP Server
```

Tool 후보:

```text
list_documents()

search_documents()

read_document()

create_document()

create_version()

compare_versions()

convert_document()

get_document_history()
```

AI가 기존 파일을 직접 덮어쓰지 않는다.

항상:

```text
Current Version

↓

AI Edit

↓

New DocumentVersion

↓

Diff

↓

AI Change Summary
```

형태로 기록한다.

---

# 50. MVP 성공 조건

다음 기능이 동작하면 MVP의 핵심을 달성했다고 본다.

1. Google 계정으로 로그인할 수 있다.
2. Workspace를 생성할 수 있다.
3. 팀별 Workspace를 구분할 수 있다.
4. 문서를 S3에 업로드할 수 있다.
5. Canvas에서 문서를 자유롭게 배치할 수 있다.
6. Document와 DocumentVersion을 분리해서 관리한다.
7. 새 파일을 기존 Document의 Version으로 연결할 수 있다.
8. AI가 Version 변경사항을 요약한다.
9. Workspace의 모든 문서를 대상으로 AI Chat을 할 수 있다.
10. AI 답변에 Source Document / Version이 표시된다.
11. OWNER / EDITOR / VIEWER 권한이 동작한다.
12. 모든 S3 접근은 권한 확인 후 Presigned URL로 제공된다.

---

# 51. MVP에서 하지 않을 것

다음 기능 때문에 핵심 개발이 늦어지지 않게 한다.

```text
복잡한 프로필 관리

다양한 로그인 Provider

2FA

Enterprise SSO

세밀한 Custom Permission

완전한 Office 호환 편집기

실시간 Google Docs 수준 공동편집

모든 파일 형식 지원

복잡한 Billing

AI Agent 자동 실행
```

---

# 52. Codex 작업 방식

Codex는 전체 시스템을 한 번에 구현하지 않는다.

항상 현재 Phase 단위로 작업한다.

각 Phase 작업 순서:

```text
1. 현재 Repository 분석

2. 기존 Architecture 파악

3. 구현 계획 작성

4. DB 변경 정의

5. Backend 구현

6. Frontend 구현

7. Test 작성

8. 기존 기능 Regression 확인

9. README / 구현 내용 문서화
```

큰 Architecture 변경이 필요하면 임의로 수정하지 말고 먼저 이유를 정리한다.

기존 동작을 불필요하게 깨뜨리지 않는다.

---

# 53. Engineering Principles

## Simple First

MVP에서는 가장 단순하게 동작하는 구현을 우선한다.

## No Premature Complexity

필요하지 않은 Microservice를 만들지 않는다.

초기에는:

```text
Next.js

FastAPI

Worker

PostgreSQL

Redis

S3
```

정도로 충분하다.

## Async Heavy Tasks

다음은 Request Thread에서 직접 오래 처리하지 않는다.

```text
Document Parsing
Embedding
AI Analysis
Conversion
Large Diff
```

## Provider Independence

AI Provider와 Storage Provider에 대한 직접 의존성을 Service Layer 밖으로 퍼뜨리지 않는다.

## Security First

Team 문서가 다른 사용자 또는 Workspace에 노출되지 않는 것을 최우선으로 한다.

---

# 54. 최종 제품 방향

이 서비스의 최종 목표는 단순한 파일 저장소가 아니다.

```text
Google Drive
+
Git-like Version Context
+
RAG
+
AI Document Intelligence
+
Visual Knowledge Workspace
```

의 성격을 가진 제품을 목표로 한다.

최종적으로:

```text
Human
   │
   ├──────────────┐
   │              │
   ▼              ▼
Web App        AI Agent

   │              │
   └───────┬──────┘
           ▼

   AI-Native Document Workspace
```

구조를 만든다.

사람과 AI가 같은 문서를 만들고 수정하더라도 모든 변화가 Version으로 남고, 그 변화의 이유와 근거를 추적할 수 있어야 한다.

이 프로젝트에서 가장 중요한 제품 가치:

> **문서를 저장하는 것이 아니라, 팀 지식이 어떻게 변화했는지를 관리한다.**
