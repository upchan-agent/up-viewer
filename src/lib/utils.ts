// Convert IPFS URL to gateway URL
export const toGatewayUrl = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined;
  if (url.startsWith('ipfs://')) {
    return `https://api.universalprofile.cloud/ipfs/${url.replace('ipfs://', '')}`;
  }
  return url;
};

// Shorten address for display
export const shortenAddress = (addr: string, chars = 4): string => {
  if (!addr) return '';
  if (addr.length < chars * 2 + 2) return addr;
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`;
};