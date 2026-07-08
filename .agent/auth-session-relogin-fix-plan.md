# Auth Session Relogin Fix Plan

## Problem

In local development, navigating from the main page to `/layout-recognize` or `/debug`, then returning to the main page, can require logging in again.

The behavior has not been observed on Railway production so far.

## Evidence

Network records show repeated authentication checks and refresh attempts:

```text
me       401  authStore.ts:192
me       401  authStore.ts:192
refresh  200  authStore.ts:159
refresh  401  authStore.ts:159
me       304  authStore.ts:192
logout   200  authStore.ts:145
me       304  authStore.ts:203
logout   200  authStore.ts:145
users    401  fetchWithAuth.ts:47
refresh  401  authStore.ts:159
logout   200  authStore.ts:145
```

## Current Relevant Code

- `/` uses `AuthGuard`, which only checks whether `accessToken` exists in localStorage.
- `/layout-recognize` and `/debug` use `AdminGuard`, which calls `loadMe()` to verify the user with `/api/me`.
- `loadMe()` directly calls `fetch('/api/me')` and handles `401` by calling `refreshAuth()`.
- `refreshAuth()` directly calls `/api/auth/refresh` and logs out on any non-OK response.
- `fetchWithAuth()` has refresh request deduplication, but `loadMe()` does not use that path.
- Local development uses React `StrictMode`, which can run effects twice.

## Likely Root Causes

### 1. Duplicate `loadMe()` in Local Dev

`client/src/main.tsx` wraps the app in `React.StrictMode`.

In development, StrictMode intentionally double-invokes effects. `AdminGuard` runs this effect:

```ts
if (accessToken && !userVerified) {
  loadMe();
}
```

This can produce two concurrent `/api/me` requests.

### 2. Refresh Token Rotation Race

When two `/api/me` requests receive `401`, both can call `refreshAuth()`.

The server uses refresh token rotation:

1. First refresh succeeds and revokes the old refresh token.
2. Second refresh still uses the old token.
3. Server rejects the second refresh with `401`.
4. Frontend treats the second refresh failure as logout-worthy and clears session.

This causes a successful refresh to be overwritten by a later failed refresh path.

### 3. `/api/me` Can Return `304`

The network log shows `/api/me` returning `304`.

Current `loadMe()` treats any non-OK response as authentication failure:

```ts
if (!res.ok) {
  await get().logout();
  return;
}
```

`Response.ok` is false for `304`, so cached `/api/me` responses can incorrectly trigger logout.

## Recommended Fix Plan

### Step 1: Disable Caching for `/api/me`

Use one or both of these approaches:

- Add `cache: 'no-store'` to both `/api/me` fetch calls in `authStore.loadMe()`.
- Add `Cache-Control: no-store` on the server response for `/api/me`.

Preferred minimal frontend change:

```ts
fetch('/api/me', {
  headers: { Authorization: `Bearer ${accessToken}` },
  credentials: 'include',
  cache: 'no-store',
})
```

Preferred server-side hardening:

```ts
res.setHeader('Cache-Control', 'no-store');
```

This prevents `304` from being treated as auth failure.

### Step 2: Deduplicate `loadMe()`

Add a module-level `loadMePromise` or store-level guard so concurrent `loadMe()` calls share the same in-flight request.

Expected behavior:

- If `loadMe()` is already running, return the same promise.
- Only one `/api/me` and one refresh path should execute at a time.
- StrictMode should not create two independent refresh flows.

### Step 3: Share Refresh Deduplication

Currently `fetchWithAuth()` deduplicates refresh, but `authStore.loadMe()` bypasses it by calling `refreshAuth()` directly.

Options:

- Move refresh deduplication into `authStore.refreshAuth()` itself.
- Or export a shared refresh helper used by both `fetchWithAuth()` and `loadMe()`.

Preferred design: put deduplication inside `refreshAuth()` so every caller is protected.

### Step 4: Avoid Full Page Reload in Debug Page

Replace the Debug page homepage link:

```tsx
<a href="/">返回主页</a>
```

with React Router navigation:

```tsx
<Link to="/">返回主页</Link>
```

This is not the main root cause, but it avoids unnecessary state reset in local development.

### Step 5: Optional Guard Consistency

Consider making `AuthGuard` also verify `loadMe()` when `accessToken` exists but `userVerified` is false.

This prevents the main page from showing a stale localStorage-only login state.

Tradeoff: the main page will wait for verification after page reload, but auth behavior becomes consistent across routes.

## Verification Steps

After implementing the fix:

1. Start local dev server with React StrictMode still enabled.
2. Log in as admin.
3. Wait until access token expires, or manually use an expired access token with a valid refresh cookie.
4. Navigate from `/` to `/layout-recognize`.
5. Confirm Network shows at most one refresh flow, or that concurrent callers share the same refresh result.
6. Confirm `/api/me` does not return `304`.
7. Navigate to `/debug`, then return to `/`.
8. Confirm no forced logout occurs.
9. Confirm non-admin users are still redirected away from admin routes.
10. Confirm invalid or revoked refresh token still logs out correctly.

## Expected Outcome

Local development should stop requiring relogin when moving between the main page, `/layout-recognize`, and `/debug`.

The fix should also make authentication more robust in production, even though the issue has not yet been observed on Railway.
