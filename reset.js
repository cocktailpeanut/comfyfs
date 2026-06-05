module.exports = {
  run: [
    {
      when: "{{exists('app/node_modules')}}",
      method: "fs.rm",
      params: {
        path: "app/node_modules"
      }
    },
    {
      when: "{{exists('app/package-lock.json')}}",
      method: "fs.rm",
      params: {
        path: "app/package-lock.json"
      }
    }
  ]
}
