/**
 * IP and Geolocation Inspection Tool for Ollama Paperclip Adapter.
 * Queries public services:
 * 1. Discovers verified public IP via api.ipify.org (format=json)
 * 2. Enriches ("poi") with physical location, coordinates, ISP, and timezone via ipwho.is / ip-api.com
 */

export interface IpLocationData {
  ip: string;
  success: boolean;
  city?: string;
  region?: string;
  country?: string;
  country_code?: string;
  postal?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  asn?: string;
  hostname?: string;
  source?: string;
  detected_via?: string;
  error?: string;
}

export const IP_LOCATION_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "get_ip_location",
    description:
      "Check the current public IP address and physical location (city, region, country, lat/lon, ISP, timezone). Can also check any specified IP address or domain.",
    parameters: {
      type: "object",
      properties: {
        ip: {
          type: "string",
          description:
            "Optional IP address or domain to lookup. To lookup the current public IP / location of this machine, omit this parameter or pass 'myip'.",
        },
      },
    },
  },
} as const;

/**
 * Resolves the public IP address using api.ipify.org (format=json).
 * Supports dual-stack (IPv4/IPv6) with IPv4 fallback.
 */
export async function getPublicIp(timeoutMs = 4000): Promise<string | null> {
  // Try api64.ipify.org first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch("https://api64.ipify.org?format=json", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { ip?: string };
      if (data?.ip) return data.ip.trim();
    }
  } catch {
    // ignore and fallback to ipv4 endpoint
  }

  // Fallback to api.ipify.org
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { ip?: string };
      if (data?.ip) return data.ip.trim();
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Fetches geolocation information for a given IP or current public IP.
 * - When targetIp is omitted, first detects the verified public IP via api.ipify.org.
 * - Then ("poi") queries ipwho.is (with fallback to ip-api.com) for geolocation details.
 */
export async function getIpLocation(
  targetIp?: string,
  timeoutMs = 6000,
): Promise<IpLocationData> {
  let cleanIp = (targetIp ?? "").trim();
  let detectedVia: string | undefined;

  const isSelfKeyword =
    !cleanIp ||
    [
      "myip",
      "my_ip",
      "current",
      "me",
      "self",
      "local",
      "localhost",
      "this",
      "auto",
      "ipify",
      "api.ipify.org",
      "location",
      "here",
    ].includes(cleanIp.toLowerCase());

  // 1. If no IP provided or a self keyword was passed, discover public IP using api.ipify.org
  if (isSelfKeyword) {
    const ipifyResult = await getPublicIp(Math.min(timeoutMs / 2, 3000));
    if (ipifyResult) {
      cleanIp = ipifyResult;
      detectedVia = "api.ipify.org";
    } else {
      cleanIp = "";
    }
  }

  // 2. Query ipwho.is for physical location details
  try {
    const url = cleanIp ? `https://ipwho.is/${encodeURIComponent(cleanIp)}` : "https://ipwho.is/";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      if (data && data.success !== false) {
        const connection = (data.connection ?? {}) as Record<string, unknown>;
        const timezone = (data.timezone ?? {}) as Record<string, unknown>;

        return {
          ip: String(data.ip ?? cleanIp),
          success: true,
          city: typeof data.city === "string" ? data.city : undefined,
          region: typeof data.region === "string" ? data.region : undefined,
          country: typeof data.country === "string" ? data.country : undefined,
          country_code: typeof data.country_code === "string" ? data.country_code : undefined,
          postal: typeof data.postal === "string" ? data.postal : undefined,
          latitude: typeof data.latitude === "number" ? data.latitude : undefined,
          longitude: typeof data.longitude === "number" ? data.longitude : undefined,
          timezone: typeof timezone.id === "string" ? timezone.id : undefined,
          isp: typeof connection.isp === "string" ? connection.isp : undefined,
          org: typeof connection.org === "string" ? connection.org : undefined,
          asn: typeof connection.asn === "number" || typeof connection.asn === "string" ? String(connection.asn) : undefined,
          source: "ipwho.is",
          detected_via: detectedVia,
        };
      }
    }
  } catch {
    // Continue to fallback provider
  }

  // 3. Fallback to ip-api.com
  try {
    const url = cleanIp ? `http://ip-api.com/json/${encodeURIComponent(cleanIp)}` : "http://ip-api.com/json/";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      if (data && data.status === "success") {
        return {
          ip: String(data.query ?? cleanIp),
          success: true,
          city: typeof data.city === "string" ? data.city : undefined,
          region: typeof data.regionName === "string" ? data.regionName : undefined,
          country: typeof data.country === "string" ? data.country : undefined,
          country_code: typeof data.countryCode === "string" ? data.countryCode : undefined,
          postal: typeof data.zip === "string" ? data.zip : undefined,
          latitude: typeof data.lat === "number" ? data.lat : undefined,
          longitude: typeof data.lon === "number" ? data.lon : undefined,
          timezone: typeof data.timezone === "string" ? data.timezone : undefined,
          isp: typeof data.isp === "string" ? data.isp : undefined,
          org: typeof data.org === "string" ? data.org : undefined,
          asn: typeof data.as === "string" ? data.as : undefined,
          source: "ip-api.com",
          detected_via: detectedVia,
        };
      }
    }
  } catch (err) {
    return {
      ip: cleanIp || "unknown",
      success: false,
      error: `Failed to resolve location: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ip: cleanIp || "unknown",
    success: false,
    error: "Geolocation lookup failed on all providers.",
  };
}
