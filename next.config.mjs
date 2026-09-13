/** @type {import('next').NextConfig} */
// GitHub Pages 项目站挂在 /<仓库名>/ 子路径下，部署时通过环境变量传入
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig = {
  output: "export",
  basePath: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
