uniform mat4 u_projectionMatrix;
uniform mat4 u_modelMatrix;
#ifdef DRAW_MODE_line
uniform vec2 u_stageSize;
#endif

attribute vec2 a_position;
attribute vec2 a_texCoord;

varying vec2 v_texCoord;

void main() {
    #ifdef DRAW_MODE_line
    vec4 screenCoord = u_modelMatrix * vec4(a_position, 0, 1);

    gl_Position = screenCoord;
    v_texCoord = ((vec2(screenCoord) * 0.5) + 0.5) * u_stageSize;
    #else
    gl_Position = u_projectionMatrix * u_modelMatrix * vec4(a_position, 0, 1);
    v_texCoord = a_texCoord;
    #endif
    
}
