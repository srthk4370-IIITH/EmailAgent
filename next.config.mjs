/** @type {import('next').NextConfig} */
const configuredOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "127.0.0.1,localhost")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

const nextConfig = {
  ...(configuredOrigins.length > 0 ? { allowedDevOrigins: configuredOrigins } : {}),
};

export default nextConfig;
