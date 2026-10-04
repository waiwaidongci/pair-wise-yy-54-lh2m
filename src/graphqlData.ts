export const seedGraph = {
  scheme: { __typename: 'Scheme', id: 'RC-2026-0918', project: '云河路快速化改造', area: '云河路 / 江海大道', version: 7 },
  reviewStats: { __typename: 'ReviewStats', pending: 1, accepted: 1, returned: 1 },
  agencies: [
    { __typename: 'Agency', id: 'AG-1', name: '市政建设集团', role: '建设' },
    { __typename: 'Agency', id: 'AG-2', name: '市交警支队', role: '交通' },
    { __typename: 'Agency', id: 'AG-3', name: '公交集团', role: '公交' },
    { __typename: 'Agency', id: 'AG-4', name: '急救中心', role: '应急' },
  ],
}
