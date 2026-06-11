export async function GET(request: Request) {
  return Response.json({ item: true });
}

export const DELETE = async (request: Request) => {
  return Response.json({ deleted: true });
};
