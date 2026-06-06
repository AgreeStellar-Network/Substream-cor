# Video Transcoding API Documentation

## Overview

The Substream-cor now includes a comprehensive video transcoding and streaming system that converts uploaded videos into HLS (HTTP Live Streaming) format with multiple resolutions for adaptive bitrate streaming.

## Features

- **Multi-resolution transcoding**: 360p, 720p, and 1080p
- **HLS streaming**: Segmented video for smooth playback
- **Adaptive bitrate**: Automatic quality selection based on connection speed
- **Storage options**: IPFS and S3-compatible storage
- **Queue management**: Background processing with Redis
- **Pay-per-second streaming**: Integration with existing subscription system

## Configuration

### Environment Variables

```bash
# Video Transcoding Configuration
FFMPEG_PATH=/usr/bin/ffmpeg
TRANSCODING_OUTPUT_DIR=./transcoded
MAX_CONCURRENT_TRANSCODINGS=3

# Redis Configuration (for job queue)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# S3 Configuration (for video storage)
S3_BUCKET=your-s3-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key

# IPFS Configuration
IPFS_HOST=localhost
IPFS_PORT=5001
IPFS_PROTOCOL=http

# CDN Configuration for video streaming
CDN_BASE_URL=https://cdn.example.com/videos
```

## API Endpoints

### Video Upload

**POST** `/api/videos/upload`

Upload a video file for transcoding and streaming.

**Request:**
- Content-Type: `multipart/form-data`
- Body:
  - `video`: Video file (mp4, avi, mov, wmv, flv)
  - `title`: Video title (required)
  - `description`: Video description (optional)
  - `creatorId`: Creator ID (required)
  - `visibility`: Video visibility (optional, default: 'private')

**Response:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "title": "My Video",
    "status": "uploaded",
    "jobId": "job-uuid",
    "message": "Video uploaded successfully. Transcoding started."
  }
}
```

### Get Video Playlist

**GET** `/api/videos/:videoId/playlist`

Get the HLS master playlist for streaming.

**Query Parameters:**
- `quality`: Optional quality override (360p, 720p, 1080p)
- `walletAddress`: Required for private videos

**Response:**
- Content-Type: `application/vnd.apple.mpegurl`
- HLS playlist content

### Get Video Segment

**GET** `/api/videos/:videoId/segment/:segmentName`

Get a specific video segment for streaming.

**Query Parameters:**
- `walletAddress`: Required for private videos

**Response:**
- Content-Type: `video/mp2t`
- Video segment data

### Get Video Status

**GET** `/api/videos/:videoId/status`

Get the processing status of a video.

**Response:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "title": "My Video",
    "status": "completed",
    "message": "Transcoding completed successfully",
    "processingStatus": {
      "status": "completed",
      "message": "Transcoding completed successfully",
      "timestamp": "2024-01-01T00:00:00.000Z"
    },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### Analyze Connection Quality

**POST** `/api/videos/:videoId/analyze-connection`

Analyze user's connection and recommend optimal video quality.

**Request Body:**
```json
{
  "bandwidth": 5.0,
  "latency": 50,
  "packetLoss": 0.01
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "jobId": "job-uuid",
    "message": "Connection analysis started"
  }
}
```

### Get Recommended Quality

**GET** `/api/videos/:videoId/recommended-quality`

Get the recommended video quality based on connection analysis.

**Response:**
```json
{
  "success": true,
  "data": {
    "videoId": "uuid",
    "recommendedQuality": "720p"
  }
}
```

### Get Queue Statistics

**GET** `/api/videos/queue/stats`

Get statistics about the video processing queue.

**Response:**
```json
{
  "success": true,
  "data": {
    "waiting": 2,
    "active": 1,
    "completed": 15,
    "failed": 0
  }
}
```

## Video Processing Workflow

1. **Upload**: User uploads video via `/api/videos/upload`
2. **Queue**: Video is added to Redis queue for processing
3. **Transcoding**: Background worker processes video:
   - Extracts video metadata
   - Creates 360p, 720p, and 1080p versions
   - Generates HLS segments (10-second chunks)
   - Creates master playlist
4. **Storage**: Transcoded files are uploaded to:
   - S3 bucket (if configured)
   - IPFS (if configured)
5. **Cleanup**: Local temporary files are removed
6. **Streaming**: Videos are available via HLS endpoints

## Adaptive Bitrate Logic

The system analyzes connection metrics to recommend optimal quality:

- **360p**: Bandwidth < 1 Mbps OR packet loss > 5%
- **720p**: Bandwidth < 3 Mbps OR latency > 200ms
- **1080p**: Bandwidth ≥ 3 Mbps AND latency ≤ 200ms AND packet loss ≤ 5%

## Storage Integration

### S3 Storage
- Automatic upload of all transcoded files
- Organized structure: `videos/{videoId}/{filename}`
- Public or private access based on configuration

### IPFS Storage
- Content-addressed storage
- Automatic pinning to IPFS network
- Returns IPFS hashes for each file

## Error Handling

### Common Error Responses

**400 Bad Request:**
```json
{
  "success": false,
  "error": "No video file provided"
}
```

**403 Forbidden:**
```json
{
  "success": false,
  "error": "Access denied. Active subscription required."
}
```

**404 Not Found:**
```json
{
  "success": false,
  "error": "Video not found"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "Failed to upload video"
}
```

## Integration with Pay-per-Second Streaming

The video transcoding system integrates seamlessly with the existing pay-per-second streaming:

1. **Authentication**: Video access requires valid subscription verification
2. **Token Generation**: CDN tokens are generated for authorized access
3. **Quality Control**: Adaptive bitrate ensures smooth streaming without buffering
4. **Usage Tracking**: Each segment request can be tracked for billing

## Performance Considerations

- **Concurrent Processing**: Configurable limit on simultaneous transcoding jobs
- **Queue Management**: Redis-based queue with retry logic
- **Storage Optimization**: Automatic cleanup of temporary files
- **CDN Integration**: Support for CDN-based delivery

## Security

- **File Validation**: Only allowed video formats are accepted
- **Size Limits**: Configurable maximum file size (default: 2GB)
- **Access Control**: Private videos require subscription verification
- **Token Security**: JWT-based access tokens for CDN

## Monitoring

- **Job Status**: Real-time status tracking of transcoding jobs
- **Queue Metrics**: Statistics on processing queue health
- **Error Logging**: Comprehensive error tracking and logging
- **Performance Metrics**: Transcoding time and success rates

## Example Usage

### Upload and Stream a Video

```javascript
// 1. Upload video
const formData = new FormData();
formData.append('video', videoFile);
formData.append('title', 'My Awesome Video');
formData.append('creatorId', 'creator-uuid');
formData.append('visibility', 'public');

const uploadResponse = await fetch('/api/videos/upload', {
  method: 'POST',
  body: formData
});

const { videoId } = await uploadResponse.json();

// 2. Get playlist
const playlistResponse = await fetch(`/api/videos/${videoId}/playlist`);
const playlist = await playlistResponse.text();

// 3. Stream video (using HLS.js or similar)
const hls = new Hls();
hls.loadSource(`/api/videos/${videoId}/playlist`);
hls.attachMedia(videoElement);
```

### Adaptive Quality Selection

```javascript
// Analyze connection
const connectionData = {
  bandwidth: 4.5, // Mbps
  latency: 120,    // ms
  packetLoss: 0.02 // 2%
};

await fetch(`/api/videos/${videoId}/analyze-connection`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(connectionData)
});

// Get recommended quality
const qualityResponse = await fetch(`/api/videos/${videoId}/recommended-quality`);
const { recommendedQuality } = await qualityResponse.json();

// Get specific quality playlist
const qualityPlaylist = await fetch(`/api/videos/${videoId}/playlist?quality=${recommendedQuality}`);
```

## Troubleshooting

### Common Issues

1. **FFmpeg not found**: Ensure FFmpeg is installed and accessible
2. **Redis connection failed**: Check Redis configuration and connectivity
3. **S3 upload failed**: Verify S3 credentials and permissions
4. **Video processing stuck**: Check queue statistics and worker logs

### Debug Commands

```bash
# Check queue status
curl http://localhost:3000/api/videos/queue/stats

# Check video status
curl http://localhost:3000/api/videos/{videoId}/status

# Test playlist access
curl http://localhost:3000/api/videos/{videoId}/playlist
```

## Future Enhancements

- **Real-time transcoding**: Live stream processing
- **AI-based quality optimization**: Machine learning for quality selection
- **Advanced codecs**: Support for AV1 and VP9
- **Multi-language audio tracks**: Support for multiple audio streams
- **Thumbnail generation**: Automatic video thumbnail creation
