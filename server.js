const app = require('./api/index.js');
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`Jagirdar Publications Backend API Server Running!`);
    console.log(`Local Server URL: http://localhost:${PORT}`);
    console.log(`Admin Panel API:  http://localhost:${PORT}/api/admin`);
    console.log(`==================================================`);
});
