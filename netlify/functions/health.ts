export default async function handler(): Promise<Response> {
  const configured =
    typeof process.env.GEMINI_API_KEY === 'string' &&
    process.env.GEMINI_API_KEY.trim().length > 0 &&
    process.env.GEMINI_API_KEY.trim() !== 'MY_GEMINI_API_KEY';

  return new Response(
    JSON.stringify({
      ok: true,
      geminiConfigured: configured,
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
