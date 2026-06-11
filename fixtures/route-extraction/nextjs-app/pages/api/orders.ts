export default function handler(req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  res.status(200).json({ orders: [] });
}
