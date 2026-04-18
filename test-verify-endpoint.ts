import "dotenv/config";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function testVerify() {
  const secret = process.env.MIDDLEWARE_VERIFY_SECRET;
  if (!secret) {
    console.error("MIDDLEWARE_VERIFY_SECRET not set in env");
    return;
  }

  const url = "http://localhost:3000/api/session/verify";
  console.log(`Testing POST ${url}`);
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-middleware-verify": secret,
      },
      body: JSON.stringify({ token: "test-token" }),
    });

    console.log(`Status: ${res.status}`);
    const text = await res.text();
    console.log(`Response: ${text}`);
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

testVerify();
