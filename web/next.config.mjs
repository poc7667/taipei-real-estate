/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@duckdb/node-api', '@duckdb/node-bindings'],
};
export default nextConfig;
