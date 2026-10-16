// SwotAtmk/infinite-creation · 开源地址 https://github.com/SwotAtmk/infinite-creation
import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'Agent无限创作 · infinite-creation',
  description: '小说 → 视频 · 全自动 Agent',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <Providers>
          {children}
          <footer className="footer">
            <a
              href="https://github.com/SwotAtmk/infinite-creation"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub"
              className="github-logo"
            />{' '}
            <span>项目地址：</span>{' '}
            <a href="https://github.com/SwotAtmk/infinite-creation" target="_blank" rel="noreferrer">https://github.com/SwotAtmk/infinite-creation</a>
            <span> 开源协议：MIT</span>{' '}
          </footer>
        </Providers>
      </body>
    </html>
  );
}
