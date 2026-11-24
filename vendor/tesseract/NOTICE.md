# vendor/tesseract — 영수증 금액 자동 인식(OCR)

영수증 사진에서 금액·날짜를 읽는 데 쓰는 브라우저 OCR 엔진입니다. 서버로 사진을 보내지 않고,
휴대폰 안에서만 인식합니다. 처음 사진을 올릴 때 한 번 내려받아 서비스워커 캐시에 남습니다.

| 파일 | 내용 | 라이선스 |
| --- | --- | --- |
| `tesseract.min.js`, `worker.min.js` | Tesseract.js 5.1.1 | Apache License 2.0 |
| `core/tesseract-core-*.wasm.js` | tesseract.js-core 5.1.0 (WebAssembly) | Apache License 2.0 |
| `lang/kor.traineddata.gz`, `lang/eng.traineddata.gz` | tessdata `4.0.0_best_int` 한국어·영어 모델 | Apache License 2.0 |

- Tesseract.js: https://github.com/naptha/tesseract.js (Apache-2.0)
- tesseract.js-core: https://github.com/naptha/tesseract.js-core (Apache-2.0)
- tessdata (tesseract-ocr): https://github.com/tesseract-ocr/tessdata (Apache-2.0)

파일은 위 배포본에서 그대로 가져왔으며 수정하지 않았습니다. 이용 약관 전문은 각 프로젝트의 LICENSE를
따릅니다. 이 앱은 `ocr.js` 에서 언어 `kor+eng`, 엔진 모드 LSTM(1), 페이지 분할 PSM 6으로 호출합니다.
