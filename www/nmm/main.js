// 시작점. 모든 페이지 파일이 PAGES에 자기를 등록한 뒤 마지막으로 실행된다.
window.addEventListener('hashchange', route);
route();
