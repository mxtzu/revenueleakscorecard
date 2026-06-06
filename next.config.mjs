const isGitHubPages = process.env.GITHUB_PAGES === "true";
const repoPath = "/revenueleakscorecard";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  basePath: isGitHubPages ? repoPath : "",
  assetPrefix: isGitHubPages ? `${repoPath}/` : undefined,
  images: {
    unoptimized: true
  }
};

export default nextConfig;
