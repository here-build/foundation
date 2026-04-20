// ----------------------------------------------------------------------
// :: Parser helper that handles circular list structures
// :: using datum labels
// ----------------------------------------------------------------------
export class DatumReference {
  constructor(
    public readonly name: any,
    public readonly data: any,
  ) {}

  valueOf() {
    return this.data;
  }
}
