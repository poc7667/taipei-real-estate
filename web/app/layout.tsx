export const metadata = {
  title: '實價登錄查詢',
  description: '臺北+新北 實價登錄分析',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body style={{ margin: 0, fontFamily: '-apple-system, "SF Pro Text", "Segoe UI", sans-serif', background: '#f8fafc', color: '#0f172a' }}>
        {children}
      </body>
    </html>
  );
}
