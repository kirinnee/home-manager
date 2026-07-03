export default {
  defaultBrowser: 'Microsoft Edge',
  rewrite: [
    {
      // Force HTTPS
      match: ({ url }) => url.protocol === 'http:',
      url: url => {
        url.protocol = 'https:';
        return url;
      },
    },
  ],
  handlers: [
    {
      // Work profile (Liftoff / Vungle)
      match: ({ urlString }) => /vungle|liftoff/i.test(urlString),
      browser: {
        name: 'Microsoft Edge',
        profile: 'Profile 3',
      },
    },
    {
      // Atomi profile
      match: ({ urlString }) => /atomi|clickup/i.test(urlString),
      browser: {
        name: 'Microsoft Edge',
        profile: 'Profile 2',
      },
    },
    {
      // Durian profile (DurianCloud)
      match: ({ urlString }) => /durian/i.test(urlString),
      browser: {
        name: 'Microsoft Edge',
        profile: 'Profile 5',
      },
    },
    {
      // Personal profile (Kirin)
      match: ({ urlString }) => /kirin/i.test(urlString),
      browser: {
        name: 'Microsoft Edge',
        profile: 'Default',
      },
    },
  ],
};
