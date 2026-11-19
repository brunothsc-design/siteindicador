export default async function handler(): Promise<Response> {
  return new Response(
    JSON.stringify({
      active: false,
      sessionId: null,
      signal: null,
      chartBounds: null,
      updatedAt: Date.now(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}
