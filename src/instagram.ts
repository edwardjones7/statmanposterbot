// Instagram API with Instagram Login (graph.instagram.com): no Facebook Page needed.
// Publishing is two-phase: create a media container from a public JPEG URL, wait until
// Instagram has fetched it, then publish the container.
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing

const GRAPH = "https://graph.instagram.com";

export class InstagramError extends Error {}

export interface Published {
  mediaId: string;
  permalink?: string;
}

export class Instagram {
  constructor(
    private readonly token: string,
    private readonly userId: string,
  ) {}

  /** One URL = single image post, 2–10 = carousel. URLs must be public JPEGs. */
  async publish(imageUrls: string[], caption: string): Promise<Published> {
    let containerId: string;
    if (imageUrls.length === 1) {
      containerId = await this.createContainer({ image_url: imageUrls[0], caption });
    } else {
      const children: string[] = [];
      for (const url of imageUrls) {
        children.push(await this.createContainer({ image_url: url, is_carousel_item: "true" }));
      }
      await Promise.all(children.map((id) => this.waitUntilReady(id)));
      containerId = await this.createContainer({ media_type: "CAROUSEL", children: children.join(","), caption });
    }
    await this.waitUntilReady(containerId);

    const { id: mediaId } = await this.call<{ id: string }>("POST", `/${this.userId}/media_publish`, {
      creation_id: containerId,
    });
    const { permalink } = await this.call<{ permalink?: string }>("GET", `/${mediaId}`, { fields: "permalink" }).catch(
      () => ({ permalink: undefined }),
    );
    return { mediaId, permalink };
  }

  private async createContainer(params: Record<string, string>): Promise<string> {
    const { id } = await this.call<{ id: string }>("POST", `/${this.userId}/media`, params);
    return id;
  }

  // Images are usually FINISHED immediately; poll briefly in case Instagram is slow to fetch.
  private async waitUntilReady(containerId: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const { status_code } = await this.call<{ status_code: string }>("GET", `/${containerId}`, {
        fields: "status_code",
      });
      if (status_code === "FINISHED") return;
      if (status_code === "ERROR" || status_code === "EXPIRED") {
        throw new InstagramError(`Instagram couldn't process the image (container ${status_code})`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new InstagramError("Instagram took too long to process the image");
  }

  private async call<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
    return graphCall<T>(method, path, { ...params, access_token: this.token });
  }
}

/** The Instagram account the token belongs to. */
export async function whoAmI(token: string): Promise<{ userId: string; username: string }> {
  const me = await graphCall<{ user_id: string; username: string }>("GET", "/me", {
    fields: "user_id,username",
    access_token: token,
  });
  return { userId: me.user_id, username: me.username };
}

/** Exchanges a long-lived token (≥24h old) for a fresh one valid 60 days. */
export async function refreshToken(token: string): Promise<{ token: string; expiresAt: number }> {
  const res = await graphCall<{ access_token: string; expires_in: number }>("GET", "/refresh_access_token", {
    grant_type: "ig_refresh_token",
    access_token: token,
  });
  return { token: res.access_token, expiresAt: Date.now() + res.expires_in * 1000 };
}

async function graphCall<T>(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  const res =
    method === "GET"
      ? await fetch(`${GRAPH}${path}?${query}`)
      : await fetch(`${GRAPH}${path}`, { method: "POST", body: query });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || body.error) {
    const e = body.error;
    throw new InstagramError(e?.message ? `${e.message}${e.code ? ` (code ${e.code})` : ""}` : `HTTP ${res.status}`);
  }
  return body;
}
