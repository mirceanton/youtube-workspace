import { Link } from "react-router";
import { PageHeader } from "../../../../src/kit/PageHeader.tsx";

export function Component() {
  return (
    <>
      <PageHeader title="Alpha list" />
      <Link to="/alpha/42">Open item 42</Link>
    </>
  );
}
