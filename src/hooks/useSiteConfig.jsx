import { useState, useEffect, createContext, useContext } from 'react';
import { getSiteConfig } from '../api/admin';

const SiteConfigContext = createContext(null);

export function SiteConfigProvider({ children }) {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    getSiteConfig()
      .then((res) => setConfig(res.data))
      .catch(() => setConfig({}));
  }, []);

  return (
    <SiteConfigContext.Provider value={config}>
      {children}
    </SiteConfigContext.Provider>
  );
}

export default function useSiteConfig() {
  return useContext(SiteConfigContext);
}
