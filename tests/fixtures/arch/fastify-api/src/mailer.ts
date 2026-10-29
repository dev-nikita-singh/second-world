// @ts-nocheck — fixture
export async function sendMail(data) {
  await fetch("https://mail.example.com/send", {
    method: "POST",
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
}
