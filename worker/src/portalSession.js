function parseSetCookies(headers) {
    if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
    const value = headers.get("set-cookie");
    return value ? value.split(/,(?=\s*[^;,]+=)/) : [];
  }
  
  function absorbCookies(jar, headers) {
    for (const raw of parseSetCookies(headers)) {
      const first = raw.split(";")[0];
      const separator = first.indexOf("=");
      if (separator > 0) {
        jar.set(first.slice(0, separator).trim(), first.slice(separator + 1).trim());
      }
    }
  }
  
  export function cookieHeader(jar) {
    return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  
  export async function login(env) {
    const jar = new Map();
    const body = new URLSearchParams({
      username: env.PORTAL_USERNAME,
      password: env.PORTAL_PASSWORD,
      remember_me: "Y"
    });
  
    let response = await fetch(env.PORTAL_LOGIN_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    absorbCookies(jar, response.headers);
  
    for (let i = 0; i < 5 && [301, 302, 303, 307, 308].includes(response.status); i++) {
      const location = response.headers.get("location");
      if (!location) break;
      response = await fetch(new URL(location, env.PORTAL_BASE_URL).toString(), {
        redirect: "manual",
        headers: { Cookie: cookieHeader(jar) }
      });
      absorbCookies(jar, response.headers);
    }
  
    if (!jar.size) throw new Error("포탈 로그인 후 세션 쿠키를 얻지 못했습니다.");
    return jar;
  }
  