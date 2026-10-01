import { useParams } from "react-router";
import { PageHeader } from "../../../../src/kit/PageHeader.tsx";

export function Component() {
  const { itemId } = useParams();
  return <PageHeader title={`Alpha item ${itemId}`} back={{ to: "/alpha", label: "Alpha list" }} />;
}
