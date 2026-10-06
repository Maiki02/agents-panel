/** The build loads `.svg` files as text (angular.json `loader`): the import is the SVG source. */
declare module '*.svg' {
  const source: string;
  export default source;
}
