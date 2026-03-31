// Convert IPFS URL to gateway URL
export const toGatewayUrl = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  if (url.startsWith('ipfs://')) {
    return `https://api.universalprofile.cloud/ipfs/${url.replace('ipfs://', '')}`;
  }
  return url;
};