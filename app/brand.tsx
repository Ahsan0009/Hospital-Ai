import Link from "next/link";

// Same petal geometry as the PayloadPipe mark, set square to read as a soft cross.
const petal = "M12 2.5c4.2 4.2 4.2 14.8 0 19-4.2-4.2-4.2-14.8 0-19z";

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={petal} className="brand-petal" />
      <path d={petal} className="brand-line" transform="rotate(90 12 12)" />
    </svg>
  );
}

export function Brand({ name, href = "/" }: { name: string; href?: string }) {
  return (
    <Link href={href} className="brand" aria-label={`${name} home`}>
      <BrandMark />
      <span>{name}</span>
    </Link>
  );
}
